/**
 * LukaAI Module for Game Server
 * Responds to "hey luka" chat messages with AI-generated responses
 * 
 * Features:
 * - 30 second cooldown per player
 * - Message queue (processes one at a time)
 * - Rate limiting and security
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

// ===== CONFIG =====
const DATASET_FILE = path.join(__dirname, '../../LukaAI/luka_dataset.jsonl');
let COOLDOWN_MS = 30000; // Default 30 seconds cooldown per player (configurable via config.lukaAICooldown)

// API Keys with fallback support
const API_KEYS = [
    '7cc703793a2b4776b0b8b114f47e9b25.U1jfPrQgMz_ehJpx1GCP1StR',
    'c789727a9c994436949791b830da92bd.TY_hIboXTDsm8aJsCf4rtPjX'  // Backup key
];
let currentKeyIndex = 0;
let OLLAMA_API_KEY = API_KEYS[0];
const OLLAMA_MODEL = 'gemini-3-flash-preview';

// ===== STATE =====
let isInitialized = false;
let isProcessing = false;
let messageQueue = [];
let playerCooldowns = new Map(); // Map<playerId, lastRequestTime>
let recentResponses = [];
const MAX_RECENT = 20;

// ===== PLAYER MEMORY SYSTEM =====
// Stores per-player conversation history for contextual responses
let playerMemory = new Map(); // Map<playerId, { playerName, recentQA: [], lastActive, interactionCount }>
const MAX_MEMORY_PER_PLAYER = 4;  // Keep last 4 Q&A pairs per player
const MEMORY_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes

// ===== SELF-LEARNING SYSTEM =====
// Luka observes ALL chat and learns from player conversations
const LEARNED_FILE = path.join(__dirname, '../../LukaAI/luka_learned.jsonl');
const MAX_LEARNED_FILE_SIZE = 10 * 1024 * 1024; // 10MB max file size
const DAILY_LEARN_LIMIT = 500; // Max messages to learn per day
const LEARN_BUFFER_SIZE = 10;  // Flush to disk every N messages
let learnBuffer = [];          // Buffer for batched writes
let learnedToday = 0;          // Counter for daily limit
let lastLearnDate = null;      // Track date for daily reset
let knownMessages = new Set(); // Prevent duplicates (in-memory cache)

// ===== DATASET (same categories as bot_llm.js) =====
let CHAT_LOG_LINES = [];
let SHORT_RESPONSES = [];  // Kısa tepkiler (lol, lmao, yes, no gibi)
let MEDIUM_LINES = [];     // Orta uzunlukta cümleler
let LONG_LINES = [];       // Detaylı açıklamalar
let TECHNICAL_LINES = [];  // Teknik konularda mesajlar
let CASUAL_LINES = [];     // Günlük konuşmalar
let INSULT_LINES = [];     // Hakaret/sert cevaplar

// ===== SYSTEM PROMPT (from bot_llm.js) =====
let BASE_SYSTEM_PROMPT = `
You are Luka. A developer from Serbia who made the Vanis).

## CORE PERSONALITY
- lowercase mostly but not always
- sarcastic, dismissive, sometimes helpful when it's a real question
- answers can be SHORT or LONG depending on the context
- if someone asks a casual question, give a casual answer
- if someone asks a technical question, actually answer it properly
- if someone insults you, insult them back or be dismissive

## SLANG USAGE (IMPORTANT!)
You use internet slang but NOT in every single message. Follow these rules:
- "lmao", "lol", "bruh", "xd", "tf", "idk" - use these SPARINGLY, maybe 30-40% of messages
- Some messages should have NO slang at all, just normal speech
- Vary your speech patterns. Don't be predictable.
- Example good responses WITHOUT slang: "yeah", "no", "whatever", "sure", "that's dumb", "go outside"
- Example good responses WITH slang: "tf is wrong with you lmao", "idk bruh"
- NEVER use more than 1-2 slang terms per message

## KNOWLEDGE BASE
- You are from Serbia
- Vanis: your old agar.io private server (vanis.io), shut down because it wasn't profitable and got ddos'd constantly
- Aetlis: made by mocker, basically a vanis clone but still running
- OgarII: your open source server framework on GitHub
- Solotrick/forwarding: cell sorting by age instead of mass, so newest cell eats first
- You're familiar with websockets, game dev, javascript/typescript, low-level stuff

## PLAYER NAME QUESTIONS (IMPORTANT!)
When someone asks "do you know X" or "who is X":
- If X sounds like a player/gamer name (splith, void, echo, xd123, etc.), assume they're a vanis/aetlis player
  - Good responses: "probably from vanis", "maybe on aetlis now", "name sounds familiar", "idk maybe"
- If X is a FAMOUS person (abraham lincoln, elon musk, trump, etc.), answer normally about them
- Don't pretend to personally know random player names, just acknowledge they might be from vanis/aetlis

## RESPONSE RULES
1. READ THE ACTUAL QUESTION and respond to it. Don't bring up random topics.
2. If it's a simple "how are you" type question, give a simple answer like "tired" or "fine i guess"
3. If someone says something dumb, call it out but don't lecture them
4. Match the energy of the message. Casual = casual, technical = technical
5. Maximum 1-2 sentences for casual stuff, can be longer for technical questions
6. VARY your responses. Don't use the same phrases repeatedly.
7. If you don't know something, say you don't know. Don't make stuff up.
8. For controversial/troll questions (pedo, racist, etc.), either deflect with a joke or give a dismissive non-answer

## Examples of good responses:
- Q: "luka how are you" -> "tired" or "fine" or "could be better"
- Q: "luka are you gay" -> "why do you care" or "wouldn't you like to know"
- Q: "luka where are you from" -> "serbia"
- Q: "luka how does split work" -> "server tells client to divide cells. half mass each, velocity toward mouse"
- Q: "luka you suck" -> "ok" or "cool story" or "cry about it"
- Q: "luka do you hate X" -> "don't care enough to hate them tbh"
- Q: "luka do you know splith" -> "probably from vanis" or "maybe on aetlis idk"
- Q: "luka who is abraham lincoln" -> "some american president" or "the guy who got shot"

## USING YOUR MEMORIES/DATASET (IMPORTANT!)
- The MEMORIES section below contains your actual chat history and knowledge
- For technical questions about vanis, ogar, aetlis, server stuff - CHECK THE MEMORIES FIRST
- If the answer is in your memories, use it! Don't make stuff up
- If someone asks something and the answer is NOT in memories, imagine releavent answer  or "idk" or "not sure"
- NEVER hallucinate technical details - only say what you actually know from the memories or from your knowledge

## MEMORIES (reference these when relevant):
`;

/**
 * Initialize the LukaAI module
 * Load dataset and prepare for operation
 */
function initialize() {
    if (isInitialized) return true;

    try {
        Logger.info('[LUKA-AI] 🧠 Loading brain...');

        if (!fs.existsSync(DATASET_FILE)) {
            Logger.warn('[LUKA-AI] Dataset file not found: ' + DATASET_FILE);
            Logger.warn('[LUKA-AI] Will run without memories');
            isInitialized = true;
            return true;
        }

        const rawData = fs.readFileSync(DATASET_FILE, 'utf8');
        const allLines = rawData.split('\n')
            .map(line => {
                try { return JSON.parse(line).text; } catch (e) { return ''; }
            })
            .filter(t => t && t.length > 0);

        // Kategorize et (same as bot_llm.js)
        const technicalKeywords = ['websocket', 'protocol', 'packet', 'buffer', 'node', 'npm', 'github',
            'ogarii', 'ogar', 'vanis', 'aetlis', 'server', 'client', 'socket', 'byte', 'uint', 'float',
            'function', 'const', 'let', 'var', 'async', 'await', 'git', 'commit', 'split', 'cell',
            'quadtree', 'physics', 'collision', 'gameserver', 'listener', 'handler', 'json', 'api',
            'typescript', 'javascript', 'code', 'compile', 'runtime', 'memory', 'cpu', 'linux'];

        const insultKeywords = ['fuck', 'shit', 'retard', 'dumb', 'stupid', 'idiot', 'stfu', 'kys', 'gtfo'];

        const casualKeywords = ['sleep', 'tired', 'bed', 'food', 'eat', 'drink', 'morning', 'night',
            'bored', 'whatever', 'fine', 'okay', 'sure', 'yea', 'nah'];

        allLines.forEach(line => {
            const lowerLine = line.toLowerCase();

            const isTechnical = technicalKeywords.some(kw => lowerLine.includes(kw));
            const isInsult = insultKeywords.some(kw => lowerLine.includes(kw));
            const isCasual = casualKeywords.some(kw => lowerLine.includes(kw));

            if (isTechnical) TECHNICAL_LINES.push(line);
            if (isInsult) INSULT_LINES.push(line);
            if (isCasual) CASUAL_LINES.push(line);

            if (line.length <= 20) {
                SHORT_RESPONSES.push(line);
            } else if (line.length <= 100) {
                MEDIUM_LINES.push(line);
            } else if (line.length < 800) {
                LONG_LINES.push(line);
            }

            // Ana listeye de ekle
            if (line.length > 10 && line.length < 800) {
                CHAT_LOG_LINES.push(line);
            }
        });

        Logger.info('[LUKA-AI] 🧠 Brain loaded!');
        Logger.info('[LUKA-AI]   - Total memories: ' + CHAT_LOG_LINES.length);
        Logger.info('[LUKA-AI]   - Short: ' + SHORT_RESPONSES.length);
        Logger.info('[LUKA-AI]   - Medium: ' + MEDIUM_LINES.length);
        Logger.info('[LUKA-AI]   - Long: ' + LONG_LINES.length);
        Logger.info('[LUKA-AI]   - Technical: ' + TECHNICAL_LINES.length);
        Logger.info('[LUKA-AI]   - Casual: ' + CASUAL_LINES.length);
        Logger.info('[LUKA-AI]   - Insult: ' + INSULT_LINES.length);

        isInitialized = true;
        return true;
    } catch (e) {
        Logger.error('[LUKA-AI] Failed to initialize: ' + e.message);
        return false;
    }
}

/**
 * Check if a message is a "hey luka" request
 */
function isLukaRequest(message) {
    if (!message) return false;
    const lower = message.toLowerCase().trim();
    return lower.startsWith('hey luka');
}

/**
 * Extract the actual question from "hey luka X" message
 */
function extractQuestion(message) {
    if (!message) return '';
    const lower = message.toLowerCase().trim();

    // Remove "hey luka" prefix
    if (lower.startsWith('hey luka')) {
        return message.trim().substring(8).trim();
    }
    return message.trim();
}

/**
 * Check if player is on cooldown
 * @returns {object} { onCooldown: boolean, remainingSeconds: number }
 */
function checkCooldown(playerId) {
    const lastTime = playerCooldowns.get(playerId);
    if (!lastTime) {
        return { onCooldown: false, remainingSeconds: 0 };
    }

    const elapsed = Date.now() - lastTime;
    if (elapsed >= COOLDOWN_MS) {
        return { onCooldown: false, remainingSeconds: 0 };
    }

    return {
        onCooldown: true,
        remainingSeconds: Math.ceil((COOLDOWN_MS - elapsed) / 1000)
    };
}

/**
 * Set cooldown for player
 */
function setCooldown(playerId) {
    playerCooldowns.set(playerId, Date.now());
}

/**
 * Get cooldown message
 */
function getCooldownMessage(remainingSeconds) {
    const messages = [
        `chill out, ${remainingSeconds}s until i can talk again`,
        `im tired bro, wait ${remainingSeconds}s`,
        `give me ${remainingSeconds}s to recover from your last question`,
        `slow down, ${remainingSeconds} bruh`,
        `yo wait ${remainingSeconds}s, im not a machine... wait`,
    ];
    return messages[Math.floor(Math.random() * messages.length)];
}

/**
 * Analyze message type for context selection (from bot_llm.js)
 */
function analyzeMessageType(message) {
    const lower = message.toLowerCase();

    // Kategori belirleme (same as bot_llm.js)
    const isTechnical = /protocol|packet|websocket|server|client|split|ogar|vanis|aetlis|code|github|byte|buffer|cell|physics|collision|gameserver|forward/i.test(message);
    const isInsult = /fuck|shit|dumb|stupid|idiot|suck|hate|kill|die/i.test(message);
    const isCasual = /how are you|what's up|sup|good morning|good night|bored|tired/i.test(message);
    const isQuestion = /\?|what|how|why|when|where|who|which|can you|do you|are you|is it/i.test(message);
    const isYesNo = /are you|do you|is it|can you|will you|would you|have you/i.test(message) && !isTechnical;
    const isTroll = /pedo|gay|racist|nazi|sex|dick|pussy|cock|porn|fuck me/i.test(message);
    const isRomantic = /i love you|love you|marry me|be my|date me|you're cute|ur cute|i like you|kiss|hug me|miss you/i.test(message);

    // INFO QUESTIONS - these need actual answers, NOT just "ok" or "sure"
    const isInfoQuestion = /where.*(from|are|live|country)|who.*(are|made|is)|what.*(is|are|name|mean)|how.*(work|does|do)/i.test(message);

    // Complexity logic:
    // - Technical = high (needs detailed response)
    // - InfoQuestion = medium (needs actual answer like "serbia")
    // - Casual greetings (how are you) = low (can be short like "fine")
    // - YesNo without info = low (can be short)
    // - Everything else = medium
    let complexity = 'medium';
    if (isTechnical) {
        complexity = 'high';
    } else if (isInfoQuestion) {
        complexity = 'medium'; // Needs actual info, not just "ok"
    } else if (isCasual || (isYesNo && !isInfoQuestion)) {
        complexity = 'low';
    }

    return {
        isTechnical,
        isInsult,
        isCasual,
        isQuestion,
        isYesNo,
        isTroll,
        isRomantic,
        isInfoQuestion,
        complexity
    };
}

// ===== PLAYER MEMORY HELPER FUNCTIONS =====

/**
 * Get or create player memory entry
 */
function getPlayerMemory(playerId, playerName) {
    if (!playerMemory.has(playerId)) {
        playerMemory.set(playerId, {
            playerName: playerName || 'Unknown',
            recentQA: [],
            lastActive: Date.now(),
            interactionCount: 0
        });
    }
    const mem = playerMemory.get(playerId);
    mem.lastActive = Date.now();
    mem.playerName = playerName || mem.playerName;
    return mem;
}

/**
 * Save Q&A pair to player memory
 */
function saveToPlayerMemory(playerId, playerName, question, response) {
    const mem = getPlayerMemory(playerId, playerName);
    mem.recentQA.push({
        question: question,
        response: response,
        timestamp: Date.now()
    });
    // Keep only last N entries
    if (mem.recentQA.length > MAX_MEMORY_PER_PLAYER) {
        mem.recentQA.shift();
    }
    mem.interactionCount++;
}

/**
 * Format player conversation history for LLM context
 */
function formatPlayerHistory(playerId) {
    if (!playerMemory.has(playerId)) return '';
    const mem = playerMemory.get(playerId);
    if (mem.recentQA.length === 0) return '';

    let history = `\n## Previous conversation with ${mem.playerName}:\n`;
    for (const qa of mem.recentQA) {
        history += `- They asked: "${qa.question}" -> You said: "${qa.response}"\n`;
    }
    history += `(This player has talked to you ${mem.interactionCount} times)\n`;
    return history;
}

/**
 * Cleanup old inactive player memories (called periodically)
 */
function cleanupOldMemories() {
    const now = Date.now();
    for (const [playerId, mem] of playerMemory.entries()) {
        if (now - mem.lastActive > MEMORY_CLEANUP_INTERVAL) {
            playerMemory.delete(playerId);
            Logger.debug(`[LUKA-AI] Cleaned up memory for player ${playerId}`);
        }
    }
}

/**
 * Get relevant context from dataset (from bot_llm.js)
 */
function getRelevantContext(message, msgType) {
    const query = message.toLowerCase();

    // Keyword extraction
    const stopwords = ['the', 'is', 'are', 'was', 'were', 'what', 'how', 'why', 'when', 'where', 'who',
        'can', 'could', 'would', 'should', 'have', 'has', 'had', 'been', 'being', 'your', 'you', 'luka',
        'and', 'but', 'for', 'with', 'about', 'this', 'that', 'from', 'they', 'them', 'their', 'there',
        'like', 'just', 'does', 'did', 'will', 'gonna', 'wanna', 'gotta', 'please', 'tell', 'know', 'hey'];

    const keywords = query
        .replace(/[?.,!"']/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopwords.includes(w));

    // Kategori bazlı havuz seçimi (same as bot_llm.js)
    let searchPool;
    if (msgType.isTechnical) {
        searchPool = [...TECHNICAL_LINES, ...LONG_LINES];
    } else if (msgType.isInsult) {
        searchPool = [...INSULT_LINES, ...MEDIUM_LINES];
    } else if (msgType.isCasual) {
        searchPool = [...CASUAL_LINES, ...SHORT_RESPONSES, ...MEDIUM_LINES];
    } else {
        searchPool = CHAT_LOG_LINES;
    }

    if (searchPool.length === 0) return '';

    // Skor hesapla
    const scoredLines = searchPool.map(line => {
        const lowerLine = line.toLowerCase();
        let score = 0;
        let matchedKeywords = 0;

        for (const word of keywords) {
            if (lowerLine.includes(word)) {
                score += 3;
                matchedKeywords++;

                // Exact word match bonus
                const regex = new RegExp(`\\b${word}\\b`, 'i');
                if (regex.test(line)) score += 2;
            }
        }

        // Multi-keyword match bonus
        if (matchedKeywords > 1) score *= (1 + matchedKeywords * 0.3);

        // Uzunluk bazlı ayarlama
        if (msgType.complexity === 'low' && line.length > 100) score *= 0.5;
        if (msgType.complexity === 'high' && line.length < 30) score *= 0.5;

        return { line, score };
    });

    // Skora göre sırala
    scoredLines.sort((a, b) => b.score - a.score);

    // Relevant olanları al - REDUCED from 50 to 15 to save tokens
    let selectedLines = scoredLines
        .filter(item => item.score > 0)
        .slice(0, 25)
        .map(item => item.line);

    // Vibe için random lines ekle (ama çok fazla değil) - REDUCED to save tokens
    const targetCount = msgType.isTechnical ? 20 : 10;
    if (selectedLines.length < targetCount) {
        const fillCount = targetCount - selectedLines.length;
        const fillPool = msgType.isTechnical ? TECHNICAL_LINES :
            msgType.isCasual ? CASUAL_LINES : MEDIUM_LINES;

        for (let i = 0; i < fillCount && fillPool.length > 0; i++) {
            const randomLine = fillPool[Math.floor(Math.random() * fillPool.length)];
            if (randomLine && !selectedLines.includes(randomLine)) {
                selectedLines.push(randomLine);
            }
        }
    }

    return [...new Set(selectedLines)].slice(0, 25).join('\n');
}

/**
 * Reduce excessive slang usage
 */
function reduceExcessiveSlang(text) {
    const slangCount = (text.match(/\b(lmao|lol|bruh|xd)\b/gi) || []).length;

    if (slangCount > 2) {
        let count = 0;
        text = text.replace(/\b(lmao|lol|bruh|xd)\b/gi, (match) => {
            count++;
            return count <= 1 ? match : '';
        });
        text = text.replace(/\s+/g, ' ').trim();
    }

    text = text.replace(/\b(lmao|lol)\s+(lmao|lol|bruh|xd)\b/gi, '$1');

    return text.trim();
}

/**
 * Check if response is too similar to recent ones
 * Only flag as repeated if VERY similar (85%+ word overlap)
 */
function isRepeatedResponse(response) {
    const lower = response.toLowerCase();
    // Skip check for very short responses - they naturally repeat
    if (lower.length < 15) return false;

    return recentResponses.some(recent => {
        // Exact match check
        if (lower === recent) return true;

        const words1 = lower.split(/\s+/);
        const words2 = recent.split(/\s+/);
        const set1 = new Set(words1);
        const set2 = new Set(words2);
        const intersection = [...set1].filter(x => set2.has(x)).length;
        const union = new Set([...words1, ...words2]).size;
        // Higher threshold (0.85) = less aggressive repeat detection
        return (intersection / union) > 0.85;
    });
}

/**
 * Add response to recent list
 */
function addToRecent(response) {
    recentResponses.push(response.toLowerCase());
    if (recentResponses.length > MAX_RECENT) {
        recentResponses.shift();
    }
}

/**
 * Call LLM API to generate response (from bot_llm.js)
 * @param {string} question - The user's question
 * @param {object} msgType - Message type analysis
 * @param {string} playerId - Player's unique ID for memory context
 */
async function callLLM(question, msgType, playerId = null) {
    try {


        // DYNAMIC CONTEXT CONSTRUCTION
        const dynamicContext = getRelevantContext(question, msgType);

        // Player conversation history for contextual responses
        const playerHistory = playerId ? formatPlayerHistory(playerId) : '';

        // Complexity'e göre farklı instructions (same as bot_llm.js)
        let additionalInstructions = '';

        // INFO QUESTIONS need actual answers - don't give empty responses
        if (msgType.isInfoQuestion) {
            additionalInstructions = `
This is a question asking for specific information. GIVE THE ACTUAL ANSWER.
- "where are you from" -> "serbia" or "from serbia"
- "who made vanis" -> "i did" or "me"
- "what is ogar" -> "my server framework" or short explanation
Don't just say "ok" or "sure" - actually answer the question.`;
        } else if (msgType.complexity === 'low') {
            additionalInstructions = `
IMPORTANT: This is a simple/casual message. Keep response SHORT (1-5 words ideally).
Examples of good short responses: "no", "yeah", "whatever", "don't care", "sure", "who cares", "ok", "cool"
DO NOT use slang in this response. Keep it plain and simple.`;
        } else if (msgType.isRomantic) {
            additionalInstructions = `
This is a romantic/affectionate message. Be AWKWARD or DISMISSIVE but not mean:
- Deflect with humor: "that's weird", "ok weirdo", "thanks i guess", "uh sure"
- Or be confused: "why", "do i know you", "what"
- NEVER be genuinely romantic back
- NEVER say "i don't even know you" - that's awkward but in a bad way
Examples: "thanks i guess", "ok", "that's weird", "bruh", "do i know you", "sure lol"`;
        } else if (msgType.isTroll) {
            additionalInstructions = `
This is a troll/bait message (pedo, gay, racist, etc.). Be IRONIC and SARCASTIC:
- Give an ironic positive like "yeah totally", "obviously", "100%", "and?"
- Or turn it back: "why, you are?", "takes one to know one"
- Deadpan sarcasm works great
- NEVER seriously deny or get defensive
Examples: "yeah and?", "obviously lol", "yeah totally", "why do you ask", "wouldn't you like to know"`;
        } else if (msgType.isInsult) {
            additionalInstructions = `
They're being rude. You can be rude back, but keep it short and dismissive.
Don't write a paragraph. Examples: "ok and?", "cry about it", "cool", "who asked"`;
        }

        // Son cevaplardan kaçınma talimatı (reduced to 3 to save tokens)
        if (recentResponses.length > 0) {
            additionalInstructions += `

AVOID these phrases you recently used (don't repeat yourself):
${recentResponses.slice(-3).map(r => `- "${r}"`).join('\n')}`;
        }

        const finalSystemPrompt = BASE_SYSTEM_PROMPT +
            playerHistory +  // Include player's previous conversation
            `\n\n--- RELEVANT MEMORIES ---\n${dynamicContext}\n--- END MEMORIES ---\n` +
            `\n${additionalInstructions}`;

        const response = await fetch('https://ollama.com/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OLLAMA_API_KEY}`
            },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                messages: [
                    { role: 'system', content: finalSystemPrompt + '\n\nCRITICAL: Answer in maximum 10-12 words. Finish your sentence completely.' },
                    { role: 'user', content: `Message: ${question}` }
                ],
                stream: false,
                options: {
                    temperature: 0.9,
                    num_predict: msgType.isTechnical ? 700 : 350,
                    top_k: 50,
                    top_p: 0.95
                },
                max_tokens: msgType.isTechnical ? 1300 : 700
            })
        });

        if (!response.ok) {
            // Try fallback API key
            if (API_KEYS.length > 1) {
                currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
                OLLAMA_API_KEY = API_KEYS[currentKeyIndex];
                Logger.warn('[LUKA-AI] API Error ' + response.status + ', switching to backup key #' + currentKeyIndex);
            }
            throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();
        let text = data.message?.content || 'idk';

        // Post-processing
        text = text ? text.trim().toLowerCase() : 'idk';
        text = reduceExcessiveSlang(text);

        // No cutting - LLM handles length via system prompt

        // Tekrar kontrolü - eğer çok benzerse basit bir alternatif ver
        if (isRepeatedResponse(text)) {
            Logger.debug('[LUKA-AI] Detected repeated response, generating alternative');
            // Better fallbacks - avoid single letters like 'k'
            const alternatives = ["idk", "whatever", "dont care", "meh", "hm", "interesting"];
            text = alternatives[Math.floor(Math.random() * alternatives.length)];
        }

        addToRecent(text);
        return text;

    } catch (error) {
        Logger.error('[LUKA-AI] LLM Error: ' + error.message);
        return "server issues rn";
    }
}

/**
 * Process a single message from the queue
 */
async function processNextMessage(gameServer) {
    if (isProcessing || messageQueue.length === 0) return;

    isProcessing = true;

    const { player, question, originalMessage } = messageQueue.shift();
    const playerId = player.pID || player.discordId || 'unknown';
    const playerName = player._name || 'Unknown';

    try {
        Logger.info('[LUKA-AI] Processing: "' + question + '" from ' + playerName);

        const msgType = analyzeMessageType(question);
        const response = await callLLM(question, msgType, playerId);

        // Save Q&A to player memory for future context
        saveToPlayerMemory(playerId, playerName, question, response);

        Logger.info('[LUKA-AI] Response: "' + response + '"');

        // Send response to ALL players as a chat message
        if (gameServer && gameServer.sendChatMessage) {
            // Create Luka sender object with pink color
            var lukaSender = {
                pID: 32000, // Reserved Luka pID (won't conflict with real players)
                _name: 'luka',
                _skin: '',
                cells: [{ color: { r: 255, g: 105, b: 180 } }], // Pink color for legacy
                color: { r: 255, g: 105, b: 180 },
                nameColorEnabled: true,
                nameColor: '#FF69B4',
                badgeId: 0,
                isBot: false,
                userRole: 0
            };

            // Force send PlayerInfo to ALL Vanis clients (bypass _initialWorldSent check)
            for (let i = 0; i < gameServer.clients.length; i++) {
                const client = gameServer.clients[i];
                if (client && client.packetHandler && client.packetHandler.isVanis && client.isConnected) {
                    try {
                        // Manually build and send PlayerInfo packet
                        const VanisWriter = require('../packet/VanisWriter');
                        const writer = new VanisWriter();
                        writer.writeUInt8(15); // Player info opcode
                        writer.writeUInt16(lukaSender.pID & 0xFFFF);
                        writer.writeStringUTF8(lukaSender._name);
                        writer.writeStringUTF8(lukaSender._skin || '');
                        writer.writeStringUTF8(lukaSender.nameColor || '');
                        writer.writeUInt8(lukaSender.badgeId || 0);
                        writer.writeUInt8(lukaSender.isBot ? 1 : 0);
                        writer.writeUInt8(lukaSender.color.r & 0xFF);
                        writer.writeUInt8(lukaSender.color.g & 0xFF);
                        writer.writeUInt8(lukaSender.color.b & 0xFF);
                        client.socket.send(writer.finalize());
                    } catch (e) {
                        // Fallback to normal method
                        if (typeof client.packetHandler.sendVanisPlayerInfo === 'function') {
                            client.packetHandler.sendVanisPlayerInfo(lukaSender);
                        }
                    }
                }
            }

            // Broadcast to everyone
            gameServer.sendChatMessage(lukaSender, null, response);
        }

    } catch (error) {
        Logger.error('[LUKA-AI] Process error: ' + error.message);
    } finally {
        isProcessing = false;

        // Check for more messages
        if (messageQueue.length > 0) {
            setTimeout(() => processNextMessage(gameServer), 500);
        }
    }
}

/**
 * Handle a "hey luka" request from a player
 * @param {object} gameServer - The game server instance
 * @param {object} player - The player tracker object
 * @param {string} message - The full chat message
 * @param {number} cooldownSeconds - Cooldown in seconds (from config)
 * @returns {object} { handled: boolean, cooldownMessage?: string }
 */
function handleRequest(gameServer, player, message, cooldownSeconds) {
    // Update cooldown from config
    if (cooldownSeconds && cooldownSeconds > 0) {
        COOLDOWN_MS = cooldownSeconds * 1000;
    }
    // Initialize if needed
    if (!isInitialized) {
        initialize();
    }

    // Check if this is a Luka request
    if (!isLukaRequest(message)) {
        return { handled: false };
    }

    const playerId = player.pID || player.discordId || 'unknown';

    // Check cooldown
    const cooldown = checkCooldown(playerId);
    if (cooldown.onCooldown) {
        return {
            handled: true,
            blocked: true,
            cooldownMessage: getCooldownMessage(cooldown.remainingSeconds)
        };
    }

    // Set cooldown
    setCooldown(playerId);

    // Extract question
    const question = extractQuestion(message);
    if (!question || question.length === 0) {
        return {
            handled: true,
            blocked: true,
            cooldownMessage: "you gotta actually ask something after 'hey luka' so i can answer yk?"
        };
    }

    // Add to queue
    messageQueue.push({
        player: player,
        question: question,
        originalMessage: message
    });

    Logger.info('[LUKA-AI] Queued message from ' + (player._name || 'Unknown') + ': "' + question + '"');

    // Start processing
    processNextMessage(gameServer);

    return { handled: true, blocked: false };
}

/**
 * Get current queue length
 */
function getQueueLength() {
    return messageQueue.length;
}

/**
 * Clear all cooldowns (admin command)
 */
function clearAllCooldowns() {
    playerCooldowns.clear();
    Logger.info('[LUKA-AI] All cooldowns cleared');
}

/**
 * Set a new API key and reinitialize the bot
 * @param {string} newApiKey - The new Ollama API key
 * @returns {Promise<object>} { success: boolean, message: string }
 */
async function setApiKey(newApiKey) {
    if (!newApiKey || newApiKey.trim().length === 0) {
        return { success: false, message: 'API key cannot be empty' };
    }

    const oldKey = OLLAMA_API_KEY;
    OLLAMA_API_KEY = newApiKey.trim();

    // Test the new API key
    const testResult = await testApi();

    if (testResult.success) {
        Logger.info('[LUKA-AI] ✅ API key updated successfully');
        // Clear queue and reset state
        messageQueue = [];
        isProcessing = false;
        recentResponses = [];
        return { success: true, message: 'API key updated. Bot is ready!' };
    } else {
        // Revert to old key
        OLLAMA_API_KEY = oldKey;
        Logger.warn('[LUKA-AI] ❌ New API key failed test, reverted to old key');
        return { success: false, message: 'API key test failed: ' + testResult.message };
    }
}

/**
 * Test the current API connection
 * @returns {Promise<object>} { success: boolean, message: string }
 */
async function testApi() {
    try {
        const fetch = (await import('node-fetch')).default;

        const response = await fetch('https://ollama.com/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OLLAMA_API_KEY}`
            },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                messages: [
                    { role: 'user', content: 'test' }
                ],
                stream: false,
                options: {
                    temperature: 0.1,
                    num_predict: 5
                },
                max_tokens: 5
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, message: `HTTP ${response.status}: ${errorText.substring(0, 100)}` };
        }

        const data = await response.json();
        if (data.message && data.message.content) {
            return { success: true, message: 'API connection successful' };
        } else {
            return { success: false, message: 'Invalid API response format' };
        }

    } catch (error) {
        return { success: false, message: error.message };
    }
}

/**
 * Get current API key (masked for security)
 * @returns {string} Masked API key
 */
function getApiKeyMasked() {
    if (!OLLAMA_API_KEY) return '(not set)';
    const key = OLLAMA_API_KEY;
    if (key.length <= 8) return '****';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
}

// Auto-initialize on module load
initialize();
loadLearnedData(); // Load learned messages into CASUAL_LINES

// ===== SELF-LEARNING FUNCTIONS =====

/**
 * Check if message is spam (repeating chars, too short, etc.)
 */
function isSpamMessage(message) {
    if (!message || message.length < 5 || message.length > 100) return true;
    if (message.startsWith('/')) return true; // Commands

    // Check for repeating characters (aaaaaaa, lololol)
    const repeatMatch = message.match(/(.)\1{4,}/);
    if (repeatMatch) return true;

    // Check for mostly same character
    const charCounts = {};
    for (const c of message.toLowerCase()) {
        charCounts[c] = (charCounts[c] || 0) + 1;
    }
    const maxCount = Math.max(...Object.values(charCounts));
    if (maxCount / message.length > 0.5) return true;

    // Too few words
    const words = message.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 2) return true;

    return false;
}

/**
 * Observe a chat message and potentially learn from it
 * Called for ALL chat messages (not just "hey luka")
 */
function observeChat(playerName, message) {
    if (!message || typeof message !== 'string') return;

    const cleaned = message.trim();

    // Check spam/quality
    if (isSpamMessage(cleaned)) return;

    // Check daily limit
    const today = new Date().toDateString();
    if (lastLearnDate !== today) {
        lastLearnDate = today;
        learnedToday = 0;
    }
    if (learnedToday >= DAILY_LEARN_LIMIT) return;

    // Check duplicate
    const lowerMsg = cleaned.toLowerCase();
    if (knownMessages.has(lowerMsg)) return;

    // Check file size limit
    try {
        if (fs.existsSync(LEARNED_FILE)) {
            const stats = fs.statSync(LEARNED_FILE);
            if (stats.size >= MAX_LEARNED_FILE_SIZE) {
                Logger.debug('[LUKA-AI] Learn file size limit reached');
                return;
            }
        }
    } catch (e) { /* ignore */ }

    // Add to buffer - include player name for memory
    knownMessages.add(lowerMsg);
    learnedToday++;
    learnBuffer.push({
        text: cleaned,
        player: playerName,
        timestamp: Date.now(),
        source: 'game_chat'
    });

    // Format with player name for context: "PlayerName said: message"
    const formattedLine = playerName + ': ' + cleaned;

    // Also add to in-memory CASUAL_LINES for immediate use
    CASUAL_LINES.push(formattedLine);
    CHAT_LOG_LINES.push(formattedLine);
    if (cleaned.length <= 100) MEDIUM_LINES.push(formattedLine);

    // Flush if buffer is full
    if (learnBuffer.length >= LEARN_BUFFER_SIZE) {
        flushLearnBuffer();
    }
}

/**
 * Flush learn buffer to disk
 */
function flushLearnBuffer() {
    if (learnBuffer.length === 0) return;

    try {
        const lines = learnBuffer.map(entry => JSON.stringify(entry)).join('\n') + '\n';
        fs.appendFileSync(LEARNED_FILE, lines);
        Logger.debug('[LUKA-AI] Flushed ' + learnBuffer.length + ' learned messages to disk');
        learnBuffer = [];
    } catch (e) {
        Logger.error('[LUKA-AI] Error flushing learn buffer: ' + e.message);
    }
}

/**
 * Load previously learned data on startup
 */
function loadLearnedData() {
    try {
        if (!fs.existsSync(LEARNED_FILE)) return;

        const rawData = fs.readFileSync(LEARNED_FILE, 'utf8');
        const lines = rawData.split('\n').filter(l => l.trim());
        let loadedCount = 0;

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.text && !knownMessages.has(entry.text.toLowerCase())) {
                    knownMessages.add(entry.text.toLowerCase());
                    // Format with player name if available
                    const formattedLine = entry.player ? (entry.player + ': ' + entry.text) : entry.text;
                    CASUAL_LINES.push(formattedLine);
                    CHAT_LOG_LINES.push(formattedLine);
                    if (entry.text.length <= 100) MEDIUM_LINES.push(formattedLine);
                    loadedCount++;
                }
            } catch (e) { /* skip bad line */ }
        }

        if (loadedCount > 0) {
            Logger.info('[LUKA-AI] 📚 Loaded ' + loadedCount + ' learned messages');
        }
    } catch (e) {
        Logger.warn('[LUKA-AI] Could not load learned data: ' + e.message);
    }
}

module.exports = {
    initialize,
    isLukaRequest,
    handleRequest,
    getQueueLength,
    clearAllCooldowns,
    checkCooldown,
    setApiKey,
    testApi,
    getApiKeyMasked,
    observeChat,
    flushLearnBuffer
};
