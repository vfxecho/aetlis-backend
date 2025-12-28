// Library imports
var WebSocket = require('ws');
var http = require('http');
var fs = require("fs");

// Project imports
var Packet = require('./packet');
var PlayerTracker = require('./PlayerTracker');
var PacketHandler = require('./PacketHandler');
var Entity = require('./entity');
var Logger = require('./modules/Logger');
var Stopwatch = require('./Stopwatch');

// Security imports - The nigga against bots and shitheads
var HCaptchaService = require('./security/HCaptchaService');
var BypassSecurityManager = require('./security/BypassSecurityManager');

// Tournament system - Where champions are forged and egos are crushed
var TournamentManager = require('./tournament/TournamentManager');



// LukaAI - The AI chatbot for in-game "hey luka" responses
var LukaAI = require('./modules/LukaAI');

// GameServer implementation
function GameServer() {
    // Location of source files - For renaming or moving source files!
    this.srcFiles = __dirname;

    // Startup
    this.run = true;
    this.version = '3.0.1';
    this.httpServer = null;
    this.commands = null;
    this.lastNodeId = 1;
    this.lastPlayerId = 1;
    this.clients = [];
    this.socketCount = 0;
    this.largestClient = null;  // Required for spectators
    this.nodes = [];            // Total nodes
    this.nodesVirus = [];       // Virus nodes
    this.nodesFood = [];        // Food nodes
    this.nodesEjected = [];     // Ejected mass nodes
    this.nodesPlayer = [];      // Player nodes

    this.movingNodes = [];      // For move engine
    this.nodesEjected = [];     // Ejected mass nodes (for tracking and cleanup)
    this.leaderboard = [];      // For leaderboard
    this.leaderboardType = -1;  // No type
    this.leaderboardChanged = false;

    // Bits per second
    this.uploadAvg = 0;
    this.downloadAvg = 0;
    this.uploadUsage = 0;
    this.downloadUsage = 0;

    var BotLoader = require('./ai/BotLoader');
    this.bots = new BotLoader(this);

    // Main loop tick
    this.startTime = this.stepDateTime = Date.now();
    this.timeStamp = 0;
    this.timerLoopBind = null;
    this.mainLoopBind = null;
    this.tickCounter = 0;
    this.disableSpawn = false;

    // =====================================
    // COLLISION OPTIMIZATION SYSTEM
    // Engine-style optimizations for high cell counts
    // Only active when config.collisionOptimization = 1
    // =====================================
    this._manifoldPool = [];          // Reusable manifold objects (avoid GC)
    this._manifoldPoolIndex = 0;      // Current pool position
    this._pendingQuadUpdates = [];    // Batch quad updates
    this._skipTickId = 0;             // Current tick ID for skip flags
    this._eatCollisionsPool = [];     // Reusable eat collision objects
    this._eatCollisionsReusable = []; // Reusable array for eatCollisions (avoids alloc per tick)
    this.updateTimes = {};            // Timing data for profiler



    // =====================================
    // HIBERNATION SYSTEM (Sleep Mode)
    // Drastically reduces CPU/Memory when no players connected
    // =====================================
    this.isHibernating = false;          // Is server in sleep mode?
    this.hibernationTimer = null;        // Timer for entering hibernation
    this.lastPlayerDisconnectTime = 0;   // When did last player leave?
    this.hibernationTickRate = 5000;     // Tick rate in hibernation (5 seconds)
    this.normalTickRate = 40;            // Normal tick rate (40ms = 25 TPS)

    // =====================================
    // WINNER SYSTEM (Mass Threshold Victory)
    // When a player reaches serverMaxMassWin, countdown starts
    // =====================================
    this.winnerCountdownActive = false;  // Is winner countdown running?
    this.winnerCountdownStartTick = 0;   // Tick when countdown started
    this.winnerPlayer = null;            // The player who reached threshold
    this.winnerName = "";                // Winner's name for display
    this.lastWinnerMessageTick = 0;      // Last tick we sent winner message
    this.isRestarting = false;           // Are we in restart process?

    // =====================================
    // COLLISION LOGGING SYSTEM
    // Debug logging for collision mechanics
    // Enable with /log-colli <playerid> command
    // =====================================
    this.collisionLogPlayerIds = new Set();  // Player IDs being logged
    this._collisionLogBuffer = [];           // Buffer for current tick's logs
    this._collisionLogLastTick = 0;          // Last tick we flushed logs

    // =====================================
    // SPATIAL GRID FOR VIEWPORT OPTIMIZATION
    // Divides map into cells for fast spatial queries
    // Dramatically reduces viewport iteration from O(n) to O(k)
    // where k = nodes in relevant grid cells
    // =====================================
    this._viewportGridSize = 2000;           // Size of each grid cell
    this._viewportGrid = null;               // Grid structure (initialized on first use)
    this._viewportGridDirty = true;          // Need to rebuild grid?
    this._viewportGridLastBuild = 0;         // Last tick grid was built

    // Config
    this.config = {
        /** LOGGING **/
        logVerbosity: 4,            // Console log level (0=NONE; 1=FATAL; 2=ERROR; 3=WARN; 4=INFO; 5=DEBUG)
        logFileVerbosity: 5,        // File log level
        optimizationLogOnly: 0,     // 1 = Only show [PROFILER] logs even when logVerbosity=0

        /** SERVER **/
        serverTimeout: 0,         // Seconds to keep connection alive for non-responding client
        serverWsModule: 'ws',       // WebSocket module: 'ws' or 'uws' (install npm package before using uws)
        serverMaxConnections: 60,  // Maximum number of connections to the server. (0 for no limit)
        serverPort: 443,            // Server port which will be used to listen for incoming connections
        serverBind: '0.0.0.0',      // Server network interface which will be used to listen for incoming connections (0.0.0.0 for all IPv4 interfaces)
        serverTracker: 0,           // Set to 1 if you want to show your server on the tracker http://ogar.mivabe.nl/master (check that your server port is opened for external connections first!)
        serverGamemode: 0,          // Gamemodes: 0 = FFA, 1 = Teams, 2 = Experimental, 3 = Rainbow
        serverBots: 0,              // Number of player bots to spawn (Experimental)
        performTest: 0,             // Performance test mode (0 = off, 1 = on). Bots randomly split/eject to stress test collision system
        serverViewBaseX: 5050,      // Base view distance of players. Warning: high values may cause lag! Min value is 1920x1080
        serverViewBaseY: 5050,      // min value is 1920x1080
        serverMinScale: 0.14,       // Minimum viewbox scale for player (low value leads to lags due to large visible area for big cell)
        serverSpectatorScale: 0.1,  // Scale (field of view) used for free roam spectators (low value leads to lags, vanilla = 0.4, old vanilla = 0.25)
        serverFreeRoamSpeed: 94,    // Speed of free roam camera movement (higher = faster, default = 32)
        serverStatsPort: 88,        // Port for stats server. Having a negative number will disable the stats server.
        serverStatsUpdate: 60,      // Update interval of server stats in seconds
        terasplitMode: 0,           // Update interval of server stats in seconds

        /** GAMESERVERS.JSON API - The player count update thingy **/
        gameserversApiUrl: 'https://aetlis.io/api/update-players',      // API URL to update player count (e.g., 'https://aetlis.io/api/update-players')
        gameserversRegion: 'EU',    // Server region (EU, TR, etc.) - must match gameservers.json

        /** AUTO-RESTART SYSTEM - Because servers need sleep too **/
        serverRestartEnabled: 1,    // Enable automatic server restart (0 = disabled, 1 = enabled)
        serverRestartMinutes: 60,   // Minutes between automatic restarts

        /** WINNER SYSTEM - Victory by reaching mass threshold **/
        serverMaxMassWin: 4500000,  // Mass threshold to win (4.5M mass). When reached, 5 second countdown starts

        /** HIBERNATION SYSTEM - Sleep mode when no players **/
        hibernationEnabled: 1,      // Enable hibernation mode (0 = disabled, 1 = enabled)
        hibernationDelay: 30,       // Seconds to wait after 0 players before entering hibernation

        /** SESSION XP SYSTEM - Grind for that sweet XP **/
        sessionTimeXPPerMinute: 10, // Base XP per minute for playing
        afkTimeout: 500,             // Seconds of no action before AFK kick (split/eject counts as action)

        mobilePhysics: 0,           // Whether or not the server uses mobile agar.io physics

        /** CENTER OF MASS COLLISION - Fixes that jittery superposition bullshit **/
        useCenterOfMassCollision: 1, // Use center-of-mass collision resolution (0 = off, 1 = on) - fixes cell stacking jitter
        centerOfMassMaxCells: 99,   // Max cells before falling back to normal collision (prevents merge delays with huge splits)

        /** CLIENT **/
        serverMaxLB: 10,            // Controls the maximum players displayed on the leaderboard.
        serverChat: 1,              // Allows the usage of server chat. 0 = no chat, 1 = use chat.
        serverChatAscii: 0,         // Set to 1 to disable non-ANSI letters in the chat (english only)
        lukaAI: 0,                  // Enable Luka AI chatbot. "hey luka <question>" triggers AI response. 0 = off, 1 = on
        lukaAICooldown: 40,         // Cooldown in seconds between "hey luka" requests per player
        serverName: 'Aetlis 3.0.1',                  // Server name
        serverWelcome1: 'Welcome to Aetlis!',     // First server welcome message
        serverWelcome2: '',         // Second server welcome message (optional, for info, etc)
        clientBind: '',             // Only allow connections to the server from specified client (eg: http://agar.io - http://mywebsite.com - http://more.com) [Use ' - ' to seperate different websites]

        /** DUAL PLAYER **/
        dualDisabled: 0,            // Disable dual player system (1 = disabled, no tab switch, no dual spawn)

        /** TOURNAMENT MODE **/
        tournamentMode: 0,          // Enable tournament mode (1 = only allowed Discord IDs can spawn)
        tournamentPlayersFile: '',  // Path to JSON file containing allowed Discord IDs

        /** ANTI-BOT **/
        serverIpLimit: 2,           // Controls the maximum number of connections from the same IP (0 for no limit)
        serverMinionIgnoreTime: 30, // minion detection disable time on server startup [seconds]
        serverMinionThreshold: 10,  // max connections within serverMinionInterval time period, which l not be marked as minion
        serverMinionInterval: 1000, // minion detection interval [milliseconds]
        serverScrambleLevel: 1,     // Toggles scrambling of coordinates. 0 = No scrambling, 1 = lightweight scrambling. 2 = full scrambling (also known as scramble minimap); 3 - high scrambling (no border)
        playerBotGrow: 0,           // Cells greater than 625 mass cannot grow from cells under 17 mass (set to 1 to disable)

        /** BORDER - OgarX style (MAP_HW / MAP_HH) **/
        MAP_HW: 15000,              // OgarX style: Half-width of map (15000 = map from -15000 to +15000 = 30000 total)
        MAP_HH: 15000,              // OgarX style: Half-height of map (15000 = map from -15000 to +15000 = 30000 total)
        useSpatialHash: 0,          // If 1, server will use a spatial hash for finding nodes. If 0, server will use quadtree instead.
        worldIsCircular: 0,         // Set to 1 to enable circular map (0 = rectangular, 1 = circular)
        worldRadius: 7071,          // Radius of circular map (only used when worldIsCircular = 1)
        borderKillsCells: 0,        // If 1, cells that cross the border will be killed (for selfeed tournaments)
        borderKillsGrace: 200,      // Grace distance past border before cells are killed (allows slight pass)
        borderStrict: 0,            // Border clamp mode: 0 = loose (radius/2 like engine non-strict), 1 = strict (radius like engine strict)
        minLoseMassPercent: 20,     // If team mass falls below this % of playerStartSize, they lose the round

        /** BORDER SHRINKING (Tournament Mode) **/
        borderShrinkEnabled: 0,     // Enable border shrinking during tournament rounds (0 = disabled, 1 = enabled)
        borderShrinkSpeed: 10,      // Border shrink speed in units per second (how fast it shrinks)
        borderShrinkMinSize: 5000,  // Minimum border size (won't shrink smaller than this)

        /** TOURNAMENT MODE **/
        tournamentRespawnCooldown: 8, // Respawn cooldown in seconds during tournament (default: 8)

        /** FOOD **/
        foodMinSize: 10,            // Minimum food size (vanilla 10)
        foodMaxSize: 20,            // Maximum food size (vanilla 20)
        invisibleFoods: false,      // Hide food visually but still eatable
        foodAmount: 1000,           // Amount of food cells on the map
        foodPerMother: 96,          // Maximum spawned food cells per mother cell
        foodMassGrow: 1,            // Enable food mass grow ?

        /** VIRUSES **/
        virusMinSize: 100,          // Minimum virus size. (vanilla: mass = val*val/100 = 100 mass)
        virusMaxSize: 141.421356237, // Maximum virus size (vanilla: mass = val*val/100 = 200 mass)
        virusMinAmount: 50,         // Minimum number of viruses on the map.
        virusMaxAmount: 100,        // Maximum number of viruses on the map. If this number is reached, then ejected cells will pass through viruses.
        motherCellMaxMass: 0,       // Maximum amount of mass a mothercell is allowed to have (0 for no limit)
        virusVelocity: 780,         // Velocity of moving viruses (speed and distance)
        virusPush: 0,               // Enable/disable virus push when eating ejected mass (0 = disabled, 1 = enabled)
        virusPushBoost: 0,          // Amount of boost added to virus when it eats ejected mass (only if virusPush is enabled)
        virusMaxBoost: 780,         // Maximum boost a virus can accumulate from eating ejected mass
        virusMonotonePop: 0,        // Enable/disable monotone virus pop: 0 = diverse split sizes, 1 = all equal sizes (OgarX style)

        /** EJECTED MASS **/
        ejectSize: 40,              // vanilla: mass = val*val/100 = 16 mass
        ejectSizeLoss: 45,          // Eject size which will be substracted from player cell (vanilla: mass = val*val/100 = 20 mass?)
        ejectCooldown: 3,           // Tick count until a player can eject mass again in ticks (1 tick = 40 ms)
        ejectSpawnPercent: 0.5,     // Chance for a player to spawn from ejected mass. 0.5 = 50% (set to 0 to disable)
        ejectVirus: 0,              // Whether or not players can eject viruses instead of mass
        ejectVelocity: 780,         // Velocity of ejecting cells (speed and distance)
        ejectMaxAge: 0,             // Max age in ticks before ejected mass is removed (0 = never remove)
        ejectHideDelay: 0,          // Hide ejected mass from clients for X ticks after creation (0 = no hide, 3 = hide for 3 ticks)
        playerNoEjectDelay: 5,      // Delay in ticks before a cell can eject after being created (e.g., from split). 0 = no delay

        /** PLAYERS **/
        playerMinSize: 31.6227766017, // Minimum size a player cell can decay too. (vanilla: val*val/100 = 10 mass)
        playerMinDecayMass: 0,      // Optional mass-based minimum decay threshold; overrides playerMinSize when > 0
        playerMaxSize: 1500,        // Maximum size a player cell can achive before auto-splitting. (vanilla: mass = val*val/100 = 22500 mass)
        playerAutoSplitSize: 0,     // Auto-split size (0 = use playerMaxSize, >0 = OgarX-style: split into equal pieces when exceeding this size)
        playerAutoSplitDelay: 100,  // Delay in ms before auto-split can occur after cell creation (OgarX-style)
        playerAutoSplitAimed: 0,    // If 1, autosplits go towards mouse direction. If 0, autosplits go in random directions
        playerVirusPopDelay: 15,    // Delay in ticks before a player can eject after popping on a virus (15 = ~600ms)
        playerMinSplitSize: 60,     // Mimimum size a player cell has to be to split. (vanilla: mass = val*val/100 = 36 mass)
        playerMinEjectSize: 56.56854249, // Minimum size a player cell has to be to eject mass. (vanilla: mass = val*val/100 = 32 mass)
        playerStartSize: 31.6227766017,  // Start size of the player cell. (vanilla: mass = val*val/100 = 10 mass)
        playerAfterDeathSize: 0,         // Size for respawning after death in tournament (0 = use playerStartSize). 316.2 = 1k mass, 447.2 = 2k mass
        playerMaxCells: 16,         // Maximum cells a player is allowed to have.
        playerSpeed: 1,             // Player speed multiplier (1 = normal speed, 2 = twice the normal speed)

        /** DECAY SYSTEM - OgarX style decay (1:1 port from engine.js) **/
        playerDecayRate: 0,         // Legacy decay rate (set to 0 to use OgarX system)
        playerDecayCap: 0,          // Maximum mass a cell can have before it's decayrate multiplies by 10. (0 to disable)
        staticDecay: 1,             // OgarX STATIC_DECAY: Base decay percentage (1 = 1%)
        dynamicDecay: 1,            // OgarX DYNAMIC_DECAY: Mass-dependent multiplier (1 = normal)
        decayMin: 1000,             // OgarX DECAY_MIN: Minimum size before decay starts (radius units)
        maxDecayMass: 0,       // Max mass threshold - above this, decay is 50% faster and mass is hard capped (0 = disabled)

        /** PLAYER VIEW - OgarX style viewport (1:1 port from engine.js) **/
        playerViewScale: 1,         // OgarX PLAYER_VIEW_SCALE: Viewport scale multiplier
        playerViewMin: 4000,        // OgarX PLAYER_VIEW_MIN: Minimum viewport size

        playerRecombineTime: 30,    // Base time in seconds before a cell is allowed to recombine
        playerMaxNickLength: 15,    // Maximum nick length
        playerDisconnectTime: 0,   // Time in seconds before a disconnected player's cells are removed (Set to -1 to never remove)
        playerDeadDelay: 75,       // Ticks before dead cells (corpses) disappear (75 = 3 seconds)
        splitVelocity: 780,         // Velocity of splitting cells (speed and distance)
        playerCollisionDelay: 10,   // Ticks before cells can collide after split (anti-instant merge)
        playerSpawnProtection: 40, // Spawn protection duration in ticks (100 ticks = 4 seconds). New players cannot eat but can be eaten.
        playerSplitCap: 1,          // Maximum splits processed per tick (for split64 etc)
        playerSplitQueueDecay: 5,   // Base ticks before split queue decays (auto-extends for big splits)
        playerSplitQueueMax: 64,   // Maximum splits that can be queued (x128 max, prevents spam)
        playerAutoRespawn: 1,       // Auto respawn when player dies (1 = enabled, 0 = disabled)
        playerRespawnDelay: 1000,   // Delay before auto respawn in milliseconds
        playerRespawnNearDeath: 1,  // Respawn near death location (1 = enabled, 0 = disabled)
        playerRespawnNearDeathDistance: 500, // Max distance from death location for near-death respawn
        playerMergeNewVersion: 1,   // Use new merge formula (1) or old (0)
        playerMergeIncrease: 0.02,  // Merge time increase per size unit
        playerNoMergeDelay: 15,     // Default no-merge delay when recombineTime is 0
        playerNoMergeDelayByMass: 0, // Enable mass-based merge delay scaling (0 = disabled)
        playerNoMergeDelay1: 15,    // Merge delay for mass threshold 1
        playerNoMergeDelay1Mass: 1000, // Mass threshold 1
        playerNoMergeDelay2: 20,    // Merge delay for mass threshold 2
        playerNoMergeDelay2Mass: 5000, // Mass threshold 2
        playerNoMergeDelay3: 25,    // Merge delay for mass threshold 3
        playerNoMergeDelay3Mass: 10000, // Mass threshold 3
        playerCellSorting: 1,       // Cell sorting mode: 0=off, 1=mouse-direction (cells closer to mouse eat first), 2=age (youngest first), 3=cytos-big (size - age*weight, big first), 4=luka-style (no sort, natural unshift order), 5=youngest-eater-first (solotrick friendly)
        playerAgeDiffThreshold: 2,  // Age gap (ticks): if age diff is below this, treat as equal for sorting tie-breaks (used by sorting mode 2)
        playerCellSortingCytosAgeWeight: 0.1, // Cytos-style weight for mode 3: score = size - age * weight (big-first)
        playerSplitReverseMass: 45000, // Mass threshold where split ordering reverses when feeding (youngest cells split first). Set to 0 to disable this feature.
        playerEatMult: 1.1401,      // Size multiplier for eating (1.14 = need to be 14% bigger to eat)
        playerEatOverlap: 3,        // Overlap divisor for eating (higher = easier to eat, vanilla = 3)
        playerEatDelay: 13,         // Ticks before cells can eat each other after split (OgarX-style)

        /** COLLISION OPTIMIZATION - Performance boost for high player counts **/
        collisionOptimization: 2,   // Collision optimization mode: 0 = original code, 1 = optimized + batch resolve, 2 = optimized + immediate resolve (best feel)


        /** BOOST TRANSFER - When eating ejected mass, transfer some boost to player **/
        boostTransferEnabled: 0,    // Enable boost transfer system (0 = disabled, use simple collision, 1 = enabled)
        playerBoostTransferMultiplier: 0.1, // Normal boost transfer strength (ogar69 style)
        playerBoostTransferReversed: 1, // Reverse boost transfer (1 = bigger cells get MORE boost)
        playerBoostTransferReverseMultiplier: 0.00025, // Reversed boost transfer strength
        playerBoostTransferBoth: 0, // If 1, both normal and reversed transfers work simultaneously

        /** MINIONS **/
        minionStartSize: 31.6227766017,    // Start size of minions (mass = 32*32/100 = 10.24)
        minionMaxStartSize: 31.6227766017, // Maximum value of random start size for minions (set value higher than minionStartSize to enable)
        disableERTP: 1,             // Whether or not to disable ERTP controls for minions. (must use ERTPcontrol script in /scripts) (Set to 0 to enable)
        disableQ: 0,                // Whether or not to disable Q controls for minions. (Set 0 to enable)
        serverMinions: 0,           // Amount of minions each player gets once they spawn
        collectPellets: 0,          // Enable collect pellets mode. To use just press P or Q. (Warning: this disables Q controls, so make sure that disableERT is 0)
        defaultName: "minion",      // Default name for all minions if name is not specified using command (put <r> before the name for random skins!)

        /** TOURNAMENT BOT SETTINGS **/
        tournamentBotStartSize: 0,  // Bot spawn size in tournament (0 = use playerStartSize). 316.2 = 1k mass, 447.2 = 2k mass

        /** SECURITY & CAPTCHA - The wall against bot armies **/
        disableCaptchaVerification: 0,  // Set to 1 to bypass captcha (for LOCAL TESTING ONLY - you absolute madman)
        security: {
            asnDenylist: [],
            offenderCooldownMs: 1500,
            tempBanMs: 600000,
            hcaptchaSecret: "ES_1164024ff8504a768b1bfd5a6e3dcbc1",  // hCaptcha secret key
            hcaptchaAllowedHostnames: ["aetlis.io", "eu.aetlis.io"]  // Only allow captcha from these domains
        },
    };

    // ========================================
    // CAPTCHA & SECURITY SERVICES
    // Initialize the bouncer squad
    // ========================================
    this.hcaptcha = null;
    this.bypassSecurityManager = null;

    this.ipBanList = [];
    this.minionTest = [];
    this.userList = [];
    this.badWords = [];

    // IP connection tracker - tracks connections per IP for serverIpLimit
    this.ipTracker = new Map();

    this.updateTime = 0;
    this.updateTimeAvg = 0;
    this.updateTimes = {};
    this.stopwatch = new Stopwatch();

    // Load files
    this.loadConfig();
    this.loadIpBanList();
    this.loadUserList();
    this.loadBadWords();
    this.loadTournamentPlayers();  // Load allowed players for tournament mode
    //yoikned from ogarx
    // MAP_HW and MAP_HH are HALF widths 
    // Total map size = MAP_HW * 2 (from -MAP_HW to +MAP_HW)

    // Auto-calculate worldRadius for circular maps 
    // For circular maps: radius = MAP_HW (half of total map size)
    if (this.config.worldIsCircular) {
        // ALWAYS use MAP_HW as radius for circular maps
        this.config.worldRadius = this.config.MAP_HW;
        Logger.info('[CIRCULAR] worldRadius set to MAP_HW: ' + this.config.worldRadius);
    }

    // Set border, quad-tree (OgarX: map from -MAP_HW to +MAP_HW)
    this.setBorder(this.config.MAP_HW * 2, this.config.MAP_HH * 2);

    var QuadNode = require('./modules/QuadNode'),
        SpatialHash = require('./modules/SpatialHash');
    if (this.config.useSpatialHash)
        this.finder = new SpatialHash(this.border, 64);
    else
        this.finder = new QuadNode(this.border, 64, 32);

    // Gamemodes
    var Gamemode = require('./gamemodes');
    this.gameMode = Gamemode.get(this.config.serverGamemode);

    // ========================================
    // INITIALIZE SECURITY SERVICES

    // ========================================
    this._initSecurityServices();

    // ========================================
    // TOURNAMENT SYSTEM

    // ========================================
    this.tournamentManager = new TournamentManager(this);

    // Initialize tournament manager with loaded team data
    this._initTournamentManagerData();
}

module.exports = GameServer;

/**
 * Initialize security services (hCaptcha, bypass manager)
 * Called during GameServer construction
 */
GameServer.prototype._initSecurityServices = function () {
    var isCaptchaDisabled = this.isCaptchaVerificationDisabled();

    if (isCaptchaDisabled) {
        this.hcaptcha = null;
        this.bypassSecurityManager = null;
        Logger.warn('[SECURITY]  Captcha verification DISABLED via config (intended for local testing only)');
    } else {
        // Initialize hCaptcha service
        var securityCfg = (this.config && this.config.security) || {};
        this.hcaptcha = new HCaptchaService({
            secret: securityCfg.hcaptchaSecret || '',
            allowedHostnames: securityCfg.hcaptchaAllowedHostnames || [],
            logger: Logger
        });

        // Initialize bypass security manager (handles Discord bypass rate limiting)
        this.bypassSecurityManager = new BypassSecurityManager(this);

        Logger.info('[SECURITY]  hCaptcha & Bypass Security initialized');
        Logger.debug('[SECURITY] Allowed hostnames: ' + (securityCfg.hcaptchaAllowedHostnames || []).join(', '));
    }
};

/**
 * Check if captcha verification is disabled
 */
GameServer.prototype.isCaptchaVerificationDisabled = function () {
    var securityCfg = (this.config && this.config.security) || {};

    // Check security config first
    if (typeof securityCfg.disableCaptchaVerification !== 'undefined') {
        return !!securityCfg.disableCaptchaVerification;
    }

    // Fall back to top-level config
    if (typeof this.config.disableCaptchaVerification !== 'undefined') {
        return !!this.config.disableCaptchaVerification;
    }

    return false;
};

// ========================================
// CAPTCHA VERIFICATION METHODS
// The actual verification magic happens here
// ========================================

/**
 * Verify hCaptcha token
 * @param {string} token - The token from client
 * @param {string} remoteIp - Client IP
 * @param {string} hostname - Optional hostname
 * @returns {Promise<{ok: boolean, code?: string}>}
 */
GameServer.prototype.verifyCaptchaToken = function (token, remoteIp, hostname) {
    if (this.isCaptchaVerificationDisabled()) {
        return Promise.resolve({ ok: true });
    }
    if (!this.hcaptcha) {
        return Promise.reject(new Error('hCaptcha service not initialized'));
    }
    return this.hcaptcha.verify(token, remoteIp, hostname);
};

/**
 * Check if captcha token has been used
 */
GameServer.prototype.isCaptchaTokenUsed = function (token, remoteIp) {
    if (this.isCaptchaVerificationDisabled()) return false;
    if (!this.hcaptcha) return false;
    return this.hcaptcha.isTokenUsed(token, remoteIp);
};

/**
 * Mark captcha token as used
 */
GameServer.prototype.markCaptchaTokenUsed = function (token, remoteIp) {
    if (this.isCaptchaVerificationDisabled()) return;
    if (!this.hcaptcha) return;
    this.hcaptcha.markTokenUsed(token, remoteIp);
};

/**
 * Validate Discord bypass attempt
 * Uses BypassSecurityManager for rate limiting and abuse detection
 */
GameServer.prototype.validateDiscordBypass = function (ip, discordUserId, discordToken) {
    if (!this.bypassSecurityManager) {
        // No security manager = allow all (only for testing)
        return { allowed: true, reason: null };
    }

    return this.bypassSecurityManager.validateBypassAttempt(ip, discordUserId, discordToken);
};

/**
 * Validate Discord token (basic validation - just checks if valid)
 * @param {string} discordToken - Discord token
 * @param {Function} callback - callback(err, isValid)
 */
GameServer.prototype.validateDiscordToken = function (discordToken, callback) {
    if (!discordToken || discordToken.length === 0) {
        callback(null, false);
        return;
    }

    // Use the full validation and just return true/false
    this.validateDiscordTokenWithUserId(discordToken, function (err, result) {
        if (err) {
            callback(err, false);
            return;
        }
        callback(null, result && result.valid);
    });
};

/**
 * Validate Discord token and extract User ID
 * This is the upgraded version that gets the actual Discord User ID for rate limiting
 * @param {string} token - Discord token
 * @param {Function} callback - callback(err, {valid: boolean, discordUserId: string, discordName: string})
 */
GameServer.prototype.validateDiscordTokenWithUserId = function (token, callback) {
    if (!token || token.length === 0) {
        callback(null, { valid: false, discordUserId: null, discordName: null });
        return;
    }

    // Resolve API base URL from config/env
    var apiBase = (this.config && this.config.apiServerUrl) || process.env.API_SERVER_URL || 'https://aetlis.io/api';

    try {
        var urlMod = require('url');
        var parsed = new urlMod.URL(apiBase + '/me');
        var useHttps = parsed.protocol === 'https:';
        var httpMod = useHttps ? require('https') : require('http');

        var options = {
            hostname: parsed.hostname,
            port: parsed.port || (useHttps ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method: 'GET',
            headers: { 'Authorization': 'Vanis ' + token },
            timeout: 5000
        };

        var req = httpMod.request(options, function (res) {
            var data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                if (res.statusCode !== 200) {
                    callback(null, { valid: false, discordUserId: null, discordName: null });
                    return;
                }

                try {
                    var json = JSON.parse(data);

                    // Extract Discord User ID - this is crucial for rate limiting
                    var discordUserId = json.discord_id || json.discordId || json.id || null;
                    var discordName = json.discord_name || json.discordName || json.username || null;

                    if (!discordUserId) {
                        Logger.warn('[DISCORD-API] ⚠️ Token valid but no Discord User ID returned');
                    }

                    callback(null, {
                        valid: true,
                        discordUserId: discordUserId,
                        discordName: discordName
                    });
                } catch (e) {
                    callback(e, null);
                }
            });
        });

        req.on('error', function (err) {
            callback(err, null);
        });

        req.on('timeout', function () {
            req.destroy();
            callback(new Error('Request timeout'), null);
        });

        req.end();

    } catch (e) {
        callback(e, null);
    }
};

GameServer.prototype.start = function () {

    this.timerLoopBind = this.timerLoop.bind(this);
    this.mainLoopBind = this.mainLoop.bind(this);

    // Client Binding
    var bind = this.config.clientBind + "";
    this.clientBind = bind.split(' - ');

    // Start the server
    this.httpServer = http.createServer();
    var wsOptions = {
        server: this.httpServer,
        perMessageDeflate: false,
        maxPayload: 4096
    };
    Logger.info("WebSocket: " + this.config.serverWsModule);
    WebSocket = require(this.config.serverWsModule);
    this.wsServer = new WebSocket.Server(wsOptions);
    this.wsServer.on('error', this.onServerSocketError.bind(this));
    this.wsServer.on('connection', this.onClientSocketOpen.bind(this));
    this.httpServer.listen(this.config.serverPort, this.config.serverBind, this.onHttpServerOpen.bind(this));

    // Start stats port (if needed)
    if (this.config.serverStatsPort > 0)
        this.startStatsServer(this.config.serverStatsPort);

    // Gamemode configurations
    this.gameMode.onServerInit(this);
};

GameServer.prototype.onHttpServerOpen = function () {
    // Start Main Loop
    setTimeout(this.timerLoopBind, 1);

    // Done
    Logger.info("Listening on port " + this.config.serverPort);
    Logger.info("Current game mode is " + this.gameMode.name);

    // Player bots (Experimental)
    if (this.config.serverBots) {
        for (var i = 0; i < this.config.serverBots; i++)
            this.bots.addBot();

        Logger.info("Added " + this.config.serverBots + " player bots");
    }

    // Start auto-restart timer if enabled
    this.startRestartTimer();
};

GameServer.prototype.addNode = function (node) {
    // Add to quad-tree & node list
    var x = node.position.x;
    var y = node.position.y;
    var size = node._size;
    node.quadItem = {
        cell: node, // update viewbox for players
        bound: { minx: x - size, miny: y - size, maxx: x + size, maxy: y + size }
    };
    this.finder.insert(node.quadItem);

    // Track index for O(1) removal when collisionOptimization enabled
    if (this.config.collisionOptimization) {
        node._nodesIndex = this.nodes.length;
    }
    this.nodes.push(node);

    // Adds to the owning player's screen
    if (node.owner) {
        node.setColor(node.owner.color);
        node.owner.cells.push(node);
        node.owner.socket.sendPacket(new Packet.AddNode(node.owner, node));
    }

    // Special on-add actions
    node.onAdd(this);

    // Gamemode actions
    this.gameMode.onCellAdd(node);
};

GameServer.prototype.onServerSocketError = function (error) {
    Logger.error("WebSocket: " + error.code + " - " + error.message);
    switch (error.code) {
        case "EADDRINUSE":
            Logger.error("Server could not bind to port " + this.config.serverPort + "!");
            Logger.error("Please close out of Skype or change 'serverPort' in gameserver.ini to a different number.");
            break;
        case "EACCES":
            Logger.error("Please make sure you are running Ogar with root privileges.");
            break;
    }
    process.exit(1); // Exits the program
};

GameServer.prototype.onClientSocketOpen = function (ws, req) {
    // Store request for backwards compatibility (new ws library passes it as 2nd param)
    ws.upgradeReq = req || ws.upgradeReq || { headers: {} };

    // Get the actual client IP (handle proxy headers if needed)
    var clientIP = ws._socket.remoteAddress;
    var headers = ws.upgradeReq.headers || {};
    if (headers['x-forwarded-for']) {
        var forwardedIPs = headers['x-forwarded-for'].split(',');
        clientIP = forwardedIPs[0].trim();
    } else if (headers['x-real-ip']) {
        clientIP = headers['x-real-ip'];
    }

    var logip = clientIP + ":" + ws._socket.remotePort;
    ws.on('error', function (err) {
        Logger.writeError("[" + logip + "] " + err.stack);
    });
    if (this.config.serverMaxConnections && this.socketCount >= this.config.serverMaxConnections) {
        ws.close(1000, "No slots");
        return;
    }
    if (this.checkIpBan(clientIP)) {
        ws.close(1000, "IP banned");
        return;
    }

    // IP limit check using ipTracker Map (per-IP connection counting)
    if (this.config.serverIpLimit > 0) {
        var currentConnections = this.ipTracker.get(clientIP) || 0;
        if (currentConnections >= this.config.serverIpLimit) {
            Logger.debug("[IP-LIMIT] Rejecting " + clientIP + " - already has " + currentConnections + "/" + this.config.serverIpLimit + " connections");
            ws.close(1000, "IP limit reached");
            return;
        }
    }

    // Check client origin binding (skip if no headers available)
    var origin = (headers && headers.origin) || 'unknown';
    if (this.config.clientBind.length && this.clientBind.indexOf(origin) < 0) {
        ws.close(1000, "Client not allowed");
        return;
    }

    ws.isConnected = true;
    ws.remoteAddress = clientIP; // Use the parsed IP, not raw socket IP
    ws.remotePort = ws._socket.remotePort;
    ws.lastAliveTime = Date.now();

    // Increment IP connection counter
    this._incrementIpConnection(clientIP);

    Logger.write("CONNECTED " + ws.remoteAddress + ":" + ws.remotePort + ", origin: \"" + origin + "\"");

    var PlayerCommand = require('./modules/PlayerCommand');
    ws.playerTracker = new PlayerTracker(this, ws);
    ws.packetHandler = new PacketHandler(this, ws);
    ws.playerCommand = new PlayerCommand(this, ws.playerTracker);

    var onMessage = function (message) {
        if (!message.length) {
            return;
        }
        // 256 is too low
        // 
        if (message.length > 4096) {
            ws.close(1009, "Spam");
            return;
        }
        ws.packetHandler.handleMessage(message);
    };
    var onError = function (error) {
        ws.sendPacket = function (data) { };
    };
    var self = this;
    var onClose = function (reason) {
        if (ws._socket.destroy != null && typeof ws._socket.destroy == 'function') {
            ws._socket.destroy();
        }

        // Release IP connection count
        self._releaseIpConnection(ws.remoteAddress);

        // CRITICAL: Clean up dual player when main player disconnects
        // Dual players don't have real sockets, so they stay in the game unless we remove them
        if (ws.playerTracker) {
            // Spawn dead cells from main player
            if (typeof self.spawnDeadCellsFromPlayer === 'function') {
                self.spawnDeadCellsFromPlayer(ws.playerTracker);
            }

            // Clean up dual player
            if (ws.playerTracker.dualPlayer) {
                Logger.info('[DISCONNECT] Cleaning up dual player ' + ws.playerTracker.dualPlayer.pID + ' for owner ' + ws.playerTracker.pID);

                // Spawn dead cells from dual player too
                if (typeof self.spawnDeadCellsFromPlayer === 'function') {
                    self.spawnDeadCellsFromPlayer(ws.playerTracker.dualPlayer);
                }

                // Remove dual from clients list
                var dualSocket = ws.playerTracker.dualPlayer.socket;
                if (dualSocket) {
                    var dualIndex = self.clients.indexOf(dualSocket);
                    if (dualIndex != -1) {
                        self.clients.splice(dualIndex, 1);
                    }
                }

                // Remove all dual cells
                while (ws.playerTracker.dualPlayer.cells.length > 0) {
                    self.removeNode(ws.playerTracker.dualPlayer.cells[0]);
                }

                // Clear auto-respawn timer
                if (ws.playerTracker.dualPlayer.clearAutoRespawnTimer) {
                    ws.playerTracker.dualPlayer.clearAutoRespawnTimer();
                }

                // Mark as removed
                ws.playerTracker.dualPlayer.isRemoved = true;
                ws.playerTracker.dualPlayer = null;
            }

            // Stop AFK checking
            if (typeof ws.playerTracker.stopAFKCheck === 'function') {
                ws.playerTracker.stopAFKCheck();
            }

            // Clear auto-respawn timer
            if (typeof ws.playerTracker.clearAutoRespawnTimer === 'function') {
                ws.playerTracker.clearAutoRespawnTimer();
            }
        }

        if (self.socketCount > 0) self.socketCount--;
        ws.isConnected = false;
        ws.sendPacket = function (data) { };
        ws.closeReason = { reason: ws._closeCode, message: ws._closeMessage };
        ws.closeTime = Date.now();
        Logger.write("DISCONNECTED " + ws.remoteAddress + ":" + ws.remotePort + ", code: " + ws._closeCode +
            ", reason: \"" + ws._closeMessage + "\", name: \"" + ws.playerTracker._name + "\"");

        // Update gameservers.json player count
        self.updateGameserversJsonOnPlayerChange();

        // Check if server should enter hibernation (0 players for 30 seconds)
        self.checkHibernation();
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
    this.socketCount++;
    this.clients.push(ws);

    // Update gameservers.json player count - someone new joined!
    this.updateGameserversJsonOnPlayerChange();

    // Wake up from hibernation if sleeping (player connected!)
    this.checkHibernation();

    // Check for external minions
    this.checkMinion(ws);
};

GameServer.prototype.checkMinion = function (ws) {
    // Check headers (maybe have a config for this?)
    // Handle case where headers might not be available
    var headers = (ws.upgradeReq && ws.upgradeReq.headers) || {};
    if (!headers['user-agent'] || !headers['cache-control'] ||
        (headers['user-agent'] && headers['user-agent'].length < 50)) {
        ws.playerTracker.isMinion = true;
    }
    // External minion detection
    if (this.config.serverMinionThreshold) {
        if ((ws.lastAliveTime - this.startTime) / 1000 >= this.config.serverMinionIgnoreTime) {
            if (this.minionTest.length >= this.config.serverMinionThreshold) {
                ws.playerTracker.isMinion = true;
                for (var i = 0; i < this.minionTest.length; i++) {
                    var playerTracker = this.minionTest[i];
                    if (!playerTracker.socket.isConnected) continue;
                    playerTracker.isMinion = true;
                }
                if (this.minionTest.length) this.minionTest.splice(0, 1);
            }
            this.minionTest.push(ws.playerTracker);
        }
    }
    // Add server minions if needed
    if (this.config.serverMinions && !ws.playerTracker.isMinion) {
        for (var i = 0; i < this.config.serverMinions; i++) {
            this.bots.addMinion(ws.playerTracker);
            ws.playerTracker.minionControl = true;
        }
    }
};

GameServer.prototype.checkIpBan = function (ipAddress) {
    if (!this.ipBanList || !this.ipBanList.length || ipAddress == "127.0.0.1") {
        return false;
    }
    if (this.ipBanList.indexOf(ipAddress) >= 0) {
        return true;
    }
    var ipBin = ipAddress.split('.');
    if (ipBin.length != 4) {
        // unknown IP format
        return false;
    }
    var subNet2 = ipBin[0] + "." + ipBin[1] + ".*.*";
    if (this.ipBanList.indexOf(subNet2) >= 0) {
        return true;
    }
    var subNet1 = ipBin[0] + "." + ipBin[1] + "." + ipBin[2] + ".*";
    if (this.ipBanList.indexOf(subNet1) >= 0) {
        return true;
    }
    return false;
};

// =====================================
// IP CONNECTION TRACKING
// Tracks connections per IP for serverIpLimit
// =====================================

/**
 * Increment connection count for an IP
 */
GameServer.prototype._incrementIpConnection = function (ip) {
    if (!ip) return;
    var count = this.ipTracker.get(ip) || 0;
    this.ipTracker.set(ip, count + 1);
    Logger.debug("[IP-TRACKER] IP " + ip + " now has " + (count + 1) + " connections");
};

/**
 * Decrement connection count for an IP
 */
GameServer.prototype._releaseIpConnection = function (ip) {
    if (!ip) return;
    var count = this.ipTracker.get(ip) || 0;
    if (count > 1) {
        this.ipTracker.set(ip, count - 1);
        Logger.debug("[IP-TRACKER] IP " + ip + " now has " + (count - 1) + " connections");
    } else {
        this.ipTracker.delete(ip);
        Logger.debug("[IP-TRACKER] IP " + ip + " removed from tracker");
    }
};

// =====================================
// HIBERNATION SYSTEM (Sleep Mode)
// When 0 players for X seconds, server goes to sleep
// Dramatically reduces CPU usage (~95% reduction)
// =====================================

/**
 * Check if server should enter or exit hibernation
 * Called when player count changes
 */
GameServer.prototype.checkHibernation = function () {
    if (!this.config.hibernationEnabled) return;

    var playerCount = this.getCurrentPlayerCount();

    if (playerCount === 0 && !this.isHibernating) {
        // No players - schedule hibernation
        this.scheduleHibernation();
    } else if (playerCount > 0 && this.isHibernating) {
        // Player connected - wake up immediately!
        this.exitHibernation();
    } else if (playerCount > 0 && this.hibernationTimer) {
        // Player connected before hibernation started - cancel timer
        this.cancelHibernation();
    }
};

/**
 * Schedule hibernation after delay
 */
GameServer.prototype.scheduleHibernation = function () {
    if (this.hibernationTimer) return; // Already scheduled
    if (this.isHibernating) return;    // Already hibernating

    var self = this;
    var delayMs = (this.config.hibernationDelay || 30) * 1000;

    Logger.info('[HIBERNATION] ⏰ No players detected. Entering sleep mode in ' +
        (this.config.hibernationDelay || 30) + ' seconds...');

    this.lastPlayerDisconnectTime = Date.now();

    this.hibernationTimer = setTimeout(function () {
        self.hibernationTimer = null;

        // Double-check still no players
        if (self.getCurrentPlayerCount() === 0) {
            self.enterHibernation();
        }
    }, delayMs);
};

/**
 * Cancel scheduled hibernation
 */
GameServer.prototype.cancelHibernation = function () {
    if (this.hibernationTimer) {
        clearTimeout(this.hibernationTimer);
        this.hibernationTimer = null;
        Logger.info('[HIBERNATION] ⚡ Timer cancelled - player connected');
    }
};

/**
 * Enter hibernation mode (sleep)
 * - Stops food/virus spawning
 * - Dramatically slows tick rate
 * - Clears non-essential nodes
 */
GameServer.prototype.enterHibernation = function () {
    if (this.isHibernating) return;

    this.isHibernating = true;

    Logger.info('[HIBERNATION] 💤 ====================================');
    Logger.info('[HIBERNATION] 💤 SERVER ENTERING SLEEP MODE');
    Logger.info('[HIBERNATION] 💤 Tick rate: ' + this.normalTickRate + 'ms -> ' + this.hibernationTickRate + 'ms');
    Logger.info('[HIBERNATION] 💤 CPU usage will drop ~95%');
    Logger.info('[HIBERNATION] 💤 ====================================');

    // Clear food and viruses to save memory
    var removedFood = 0;
    var removedVirus = 0;

    // Remove all food
    while (this.nodesFood.length > 0) {
        this.removeNode(this.nodesFood[0]);
        removedFood++;
    }

    // Remove all viruses
    while (this.nodesVirus.length > 0) {
        this.removeNode(this.nodesVirus[0]);
        removedVirus++;
    }

    // Remove all ejected mass
    var removedEjected = 0;
    while (this.nodesEjected.length > 0) {
        this.removeNode(this.nodesEjected[0]);
        removedEjected++;
    }

    Logger.info('[HIBERNATION] 💤 Cleared: ' + removedFood + ' food, ' +
        removedVirus + ' viruses, ' + removedEjected + ' ejected mass');

    // Update gameservers.json to show 0 players
    this.updateGameserversJsonOnPlayerChange();
};

/**
 * Exit hibernation mode (wake up)
 * - Restores normal tick rate
 * - Spawns food and viruses
 * - Resumes normal operation
 */
GameServer.prototype.exitHibernation = function () {
    if (!this.isHibernating) return;

    var sleepDuration = Date.now() - this.lastPlayerDisconnectTime;
    var sleepMinutes = Math.floor(sleepDuration / 60000);
    var sleepSeconds = Math.floor((sleepDuration % 60000) / 1000);

    Logger.info('[HIBERNATION] ⚡ ====================================');
    Logger.info('[HIBERNATION] ⚡ SERVER WAKING UP!');
    Logger.info('[HIBERNATION] ⚡ Was asleep for: ' + sleepMinutes + 'm ' + sleepSeconds + 's');
    Logger.info('[HIBERNATION] ⚡ Tick rate: ' + this.hibernationTickRate + 'ms -> ' + this.normalTickRate + 'ms');
    Logger.info('[HIBERNATION] ⚡ ====================================');

    this.isHibernating = false;

    // Cancel any pending hibernation timer
    if (this.hibernationTimer) {
        clearTimeout(this.hibernationTimer);
        this.hibernationTimer = null;
    }

    // Force immediate tick to resume gameplay
    // Food and viruses will be spawned in next ticks by gameMode.onTick
    Logger.info('[HIBERNATION] ⚡ Spawning food and viruses...');
};

/**
 * Check if server is in hibernation mode
 */
GameServer.prototype.isInHibernation = function () {
    return this.isHibernating === true;
};

GameServer.prototype.setBorder = function (width, height) {
    var hw = width / 2;
    var hh = height / 2;
    this.border = {
        minx: -hw, miny: -hh, maxx: hw, maxy: hh, width: width, height: height
    };

    // Store original border for reset (OgarX style)
    // ALWAYS update on setBorder (don't check if exists)
    // This ensures MAP_HW changes are reflected
    this.originalBorder = {
        width: width,
        height: height,
        MAP_HW: hw,           // Store half-width (OgarX style)
        MAP_HH: hh,           // Store half-height (OgarX style)  
        radius: this.config.worldRadius
    };
};

/**
 * Update border size dynamically (used for border shrinking)
 * Rebuilds finder/quadtree and broadcasts update to all clients
 */
GameServer.prototype.updateBorderSize = function (newWidth, newHeight, newRadius) {
    var oldBorder = this.border;

    // Update rectangular border
    var hw = newWidth / 2;
    var hh = newHeight / 2;
    this.border = {
        minx: -hw, miny: -hh, maxx: hw, maxy: hh, width: newWidth, height: newHeight
    };

    // Update circular radius if applicable
    if (this.config.worldIsCircular && newRadius !== undefined) {
        this.config.worldRadius = newRadius;
    }

    // Rebuild the finder/quadtree with new border bounds
    this.rebuildFinder();

    // Broadcast border update to all connected clients
    this.broadcastBorderUpdate();

    Logger.debug('[BORDER] Border updated: ' + Math.floor(newWidth) + 'x' + Math.floor(newHeight) +
        (this.config.worldIsCircular ? ' (radius: ' + Math.floor(newRadius) + ')' : ''));
};

/**
 * Rebuild the finder/quadtree with current border bounds
 * Keeps all existing cells but repositions them in the new structure
 */
GameServer.prototype.rebuildFinder = function () {
    var SpatialHash = require('./modules/SpatialHash');
    var QuadNode = require('./modules/QuadNode');

    // Collect all items from current finder
    var allItems = [];
    for (var i = 0; i < this.nodes.length; i++) {
        var node = this.nodes[i];
        if (node.quadItem) {
            allItems.push(node.quadItem);
            node.quadItem._quadNode = null; // Detach from old quadtree
        }
    }

    // Create new finder with updated border
    if (this.config.useSpatialHash) {
        this.finder = new SpatialHash(this.border, 64);
    } else {
        this.finder = new QuadNode(this.border, 64, 32);
    }

    // Re-insert all items into new finder
    for (var i = 0; i < allItems.length; i++) {
        var item = allItems[i];
        // Clamp item bounds to new border if needed
        if (item.bound) {
            item.bound.minx = Math.max(this.border.minx, Math.min(this.border.maxx, item.bound.minx));
            item.bound.miny = Math.max(this.border.miny, Math.min(this.border.maxy, item.bound.miny));
            item.bound.maxx = Math.max(this.border.minx, Math.min(this.border.maxx, item.bound.maxx));
            item.bound.maxy = Math.max(this.border.miny, Math.min(this.border.maxy, item.bound.maxy));
        }
        this.finder.insert(item);
    }
};

/**
 * Broadcast border update to all connected clients
 */
GameServer.prototype.broadcastBorderUpdate = function () {
    var Packet = require('./packet');

    for (var i = 0; i < this.clients.length; i++) {
        var client = this.clients[i];
        if (!client || !client.playerTracker) continue;

        // Send updated border packet
        var borderPacket = new Packet.SetBorder(client.playerTracker, this.border);
        client.sendPacket(borderPacket);
    }
};

/**
 * Reset border to original size (used when tournament ends or round resets)
 */
GameServer.prototype.resetBorderToOriginal = function () {
    if (!this.originalBorder) return;

    this.updateBorderSize(
        this.originalBorder.width,
        this.originalBorder.height,
        this.originalBorder.radius
    );

    Logger.info('[BORDER] Border reset to original size');
};

GameServer.prototype.getRandomColor = function () {
    // get random
    var colorRGB = [0xFF, 0x07, (Math.random() * 256) >> 0];
    colorRGB.sort(function () {
        return 0.5 - Math.random();
    });
    // return random
    return {
        r: colorRGB[0],
        b: colorRGB[1],
        g: colorRGB[2]
    };
};

// Soulless/pale colors for bots - washed out, lifeless tones
GameServer.prototype.getSoullessColor = function () {
    // Generate pale/washed out colors that look "soulless"
    // Mix random color with gray to make it look lifeless
    var baseColors = [
        { r: 180, g: 180, b: 200 }, // Pale blue-gray
        { r: 200, g: 180, b: 180 }, // Pale pink-gray
        { r: 180, g: 200, b: 180 }, // Pale green-gray
        { r: 200, g: 200, b: 180 }, // Pale yellow-gray
        { r: 190, g: 180, b: 200 }, // Pale purple-gray
        { r: 200, g: 190, b: 180 }, // Pale orange-gray
        { r: 185, g: 185, b: 185 }, // Pure gray
        { r: 170, g: 190, b: 200 }, // Pale cyan-gray
        { r: 200, g: 185, b: 190 }, // Pale salmon-gray
        { r: 175, g: 195, b: 185 }, // Pale teal-gray
    ];

    // Pick a random base and add slight variation
    var base = baseColors[Math.floor(Math.random() * baseColors.length)];
    var variation = 15;

    return {
        r: Math.max(140, Math.min(220, base.r + (Math.random() * variation * 2 - variation) >> 0)),
        g: Math.max(140, Math.min(220, base.g + (Math.random() * variation * 2 - variation) >> 0)),
        b: Math.max(140, Math.min(220, base.b + (Math.random() * variation * 2 - variation) >> 0))
    };
};

// Get color for bots - uses soulless colors
GameServer.prototype.getBotColor = function () {
    return this.getSoullessColor();
};

// Get spawn color for a player - bots get soulless colors, players get random
GameServer.prototype.getSpawnColorForPlayer = function (player) {
    if (player && player.socket && player.socket.isBot) {
        return this.getBotColor();
    }
    return this.getRandomColor();
};

GameServer.prototype.removeNode = function (node) {
    // Remove from quad-tree
    node.isRemoved = true;
    this.finder.remove(node.quadItem);
    node.quadItem = null;

    // Remove from main nodes list
    if (this.config.collisionOptimization) {
        // O(1) removal using swap-and-pop (only when optimization enabled)
        if (node._nodesIndex !== undefined && node._nodesIndex < this.nodes.length) {
            var lastNode = this.nodes[this.nodes.length - 1];
            if (lastNode !== node) {
                this.nodes[node._nodesIndex] = lastNode;
                lastNode._nodesIndex = node._nodesIndex;
            }
            this.nodes.pop();
            node._nodesIndex = undefined;
        }
        // O(1) removal from movingNodes
        if (node._movingIndex !== undefined && node._movingIndex < this.movingNodes.length) {
            var lastMoving = this.movingNodes[this.movingNodes.length - 1];
            if (lastMoving !== node) {
                this.movingNodes[node._movingIndex] = lastMoving;
                lastMoving._movingIndex = node._movingIndex;
            }
            this.movingNodes.pop();
            node._movingIndex = undefined;
        }
    } else {
        // Original O(n) removal (when optimization disabled)
        var index = this.nodes.indexOf(node);
        if (index != -1) this.nodes.splice(index, 1);

        index = this.movingNodes.indexOf(node);
        if (index != -1) this.movingNodes.splice(index, 1);
    }

    // Special on-remove actions
    node.onRemove(this);
};

GameServer.prototype.updateClients = function () {
    // check minions
    for (var i = 0, test = this.minionTest.length; i < test;) {
        if (!this.minionTest[i]) {
            i++;
            continue;
        }
        var date = new Date() - this.minionTest[i].connectedTime;
        if (date > this.config.serverMinionInterval)
            this.minionTest.splice(i, 1);
        else
            i++;
    }

    // check dead clients
    var len = this.clients.length;
    for (var i = 0; i < len;) {
        if (!this.clients[i]) {
            i++;
            continue;
        }
        this.clients[i].playerTracker.checkConnection();
        if (this.clients[i].playerTracker.isRemoved)
            // remove dead client
            this.clients.splice(i, 1);
        else
            i++;
    }

    // update (Luka's original - simple, no throttling)
    len = this.clients.length;
    for (var i = 0; i < len; i++)
        this.clients[i].playerTracker.updateTick();

    for (var i = 0; i < len; i++)
        this.clients[i].playerTracker.sendUpdate();

    // TOURNAMENT MODE: Send ForceSpectate only at the beginning, not continuously
    // Continuous sending was causing spectate mode to keep resetting (freeroam toggle issues)
    if (this.tournamentData && this.tournamentData.enabled) {
        for (var i = 0; i < len; i++) {
            var client = this.clients[i];
            if (!client || !client.playerTracker) continue;

            var player = client.playerTracker;

            // Only target blocked players who haven't been fully initialized yet
            if (player._tournamentSpawnBlocked && !player._tournamentSpectateInitialized) {
                // Set spectator mode once
                player.spectate = true;
                player.freeRoam = true;

                // Initialize counter if not exists
                if (typeof player._forceSpectateCounter === 'undefined') {
                    player._forceSpectateCounter = 0;
                }

                // Send ForceSpectate packet only for first 2 seconds (50 ticks at 25 tps)
                if (player._forceSpectateCounter < 50) {
                    if (client.packetHandler && client.packetHandler.sendVanisForceSpectate) {
                        client.packetHandler.sendVanisForceSpectate();
                    }
                    player._forceSpectateCounter++;
                } else {
                    // After 2 seconds, mark as initialized and stop sending
                    player._tournamentSpectateInitialized = true;
                }
            }
        }
    }
};

// =====================================
// VIEWPORT QUERY WITH SPATIAL GRID
// Optimized viewport query using spatial hashing
// Reduces iteration from O(n) to O(k) where k = nodes in view
// =====================================

GameServer.prototype._buildViewportGrid = function () {
    var gridSize = this._viewportGridSize;
    var border = this.border;

    // Calculate grid dimensions
    var gridWidth = Math.ceil(border.width / gridSize) + 2;
    var gridHeight = Math.ceil(border.height / gridSize) + 2;
    var offsetX = border.minx;
    var offsetY = border.miny;

    // Initialize or clear grid
    if (!this._viewportGrid || this._viewportGrid.width !== gridWidth) {
        this._viewportGrid = {
            cells: [],
            width: gridWidth,
            height: gridHeight,
            offsetX: offsetX,
            offsetY: offsetY,
            gridSize: gridSize
        };
        for (var i = 0; i < gridWidth * gridHeight; i++) {
            this._viewportGrid.cells[i] = [];
        }
    } else {
        // Clear existing cells
        for (var i = 0; i < this._viewportGrid.cells.length; i++) {
            this._viewportGrid.cells[i].length = 0;
        }
    }

    var grid = this._viewportGrid;
    var nodes = this.nodes;

    // Insert all nodes into grid
    for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!node || node.isRemoved) continue;

        var pos = node.position;
        var size = node._size;

        // Calculate grid cell range this node occupies
        var minGx = Math.floor((pos.x - size - offsetX) / gridSize);
        var maxGx = Math.floor((pos.x + size - offsetX) / gridSize);
        var minGy = Math.floor((pos.y - size - offsetY) / gridSize);
        var maxGy = Math.floor((pos.y + size - offsetY) / gridSize);

        // Clamp to grid bounds
        minGx = Math.max(0, minGx);
        maxGx = Math.min(gridWidth - 1, maxGx);
        minGy = Math.max(0, minGy);
        maxGy = Math.min(gridHeight - 1, maxGy);

        // Insert into all overlapping grid cells
        for (var gx = minGx; gx <= maxGx; gx++) {
            for (var gy = minGy; gy <= maxGy; gy++) {
                var cellIdx = gy * gridWidth + gx;
                grid.cells[cellIdx].push(node);
            }
        }
    }

    this._viewportGridLastBuild = this.tickCounter;
    this._viewportGridDirty = false;
};

GameServer.prototype.queryViewport = function (minx, maxx, miny, maxy) {
    // Rebuild grid if dirty or not built this tick
    if (this._viewportGridDirty || this._viewportGridLastBuild !== this.tickCounter) {
        this._buildViewportGrid();
    }

    var grid = this._viewportGrid;
    if (!grid) {
        // Fallback to linear scan
        var result = [];
        for (var i = 0; i < this.nodes.length; i++) {
            var node = this.nodes[i];
            if (!node || node.isRemoved) continue;
            var pos = node.position;
            var size = node._size;
            if (pos.x + size >= minx && pos.x - size <= maxx &&
                pos.y + size >= miny && pos.y - size <= maxy) {
                result.push(node);
            }
        }
        return result;
    }

    var gridSize = grid.gridSize;
    var offsetX = grid.offsetX;
    var offsetY = grid.offsetY;
    var gridWidth = grid.width;
    var gridHeight = grid.height;

    // Calculate grid cell range for viewport
    var minGx = Math.floor((minx - offsetX) / gridSize);
    var maxGx = Math.floor((maxx - offsetX) / gridSize);
    var minGy = Math.floor((miny - offsetY) / gridSize);
    var maxGy = Math.floor((maxy - offsetY) / gridSize);

    // Clamp to grid bounds
    minGx = Math.max(0, minGx);
    maxGx = Math.min(gridWidth - 1, maxGx);
    minGy = Math.max(0, minGy);
    maxGy = Math.min(gridHeight - 1, maxGy);

    // Use Set for deduplication (nodes can be in multiple cells)
    var seen = {};
    var result = [];

    for (var gx = minGx; gx <= maxGx; gx++) {
        for (var gy = minGy; gy <= maxGy; gy++) {
            var cellIdx = gy * gridWidth + gx;
            var cellNodes = grid.cells[cellIdx];

            for (var i = 0; i < cellNodes.length; i++) {
                var node = cellNodes[i];

                // Skip if already seen
                if (seen[node.nodeId]) continue;
                seen[node.nodeId] = true;

                // Precise bounds check
                var pos = node.position;
                var size = node._size;
                if (pos.x + size >= minx && pos.x - size <= maxx &&
                    pos.y + size >= miny && pos.y - size <= maxy) {
                    result.push(node);
                }
            }
        }
    }

    return result;
};

GameServer.prototype.updateLeaderboard = function () {
    // Update leaderboard with the gamemode's method
    this.leaderboard = [];
    this.leaderboardType = -1;
    this.gameMode.updateLB(this);

    if (!this.gameMode.specByLeaderboard) {
        // Get client with largest score if gamemode doesn't have a leaderboard
        var clients = this.clients.valueOf();

        // Use sort function
        clients.sort(function (a, b) {
            return b.playerTracker._score - a.playerTracker._score;
        });
        this.largestClient = null;
        if (clients[0]) this.largestClient = clients[0].playerTracker;
    } else
        this.largestClient = this.gameMode.rankOne;
};

GameServer.prototype.onChatMessage = function (from, to, message) {
    if (!message) return;
    message = message.trim();
    if (message === "") return;
    if (from && message.length && message[0] == '/') {
        // player command
        message = message.slice(1, message.length);
        from.socket.playerCommand.executeCommandLine(message);
        return;
    }
    if (!this.config.serverChat || (from && from.isMuted)) {
        // chat is disabled or player is muted
        return;
    }

    // Filter "vanis" variations and replace with "Aetlis"
    // Handles spaced/extended versions like "v.a.n.i.s", "v a n n i s", "vaniss"
    // Regex explanation:
    // v + separators + a + separators + n + (separators + n)* + separators + i + (separators + i)* + separators + s + (separators + s)*
    message = message.replace(/v[\s\W]*a[\s\W]*n(?:[\s\W]*n)*[\s\W]*i(?:[\s\W]*i)*[\s\W]*s(?:[\s\W]*s)*/gi, "Aetlis");

    // Check if player has Discord login and minimum level 2
    // Because random trolls shouldn't have chat access
    if (from) {
        var hasDiscord = from.discordToken && from.discordToken.length > 0;
        var hasMinLevel = from.currentLevel >= 2;

        Logger.debug('[CHAT-CHECK] Player: ' + from._name + ' Token: ' + (from.discordToken ? 'exists' : 'MISSING') + ' Level: ' + from.currentLevel);

        if (!hasDiscord) {
            // No Discord login - can't chat without logging in
            Logger.debug('[CHAT-CHECK] ❌ REJECTED - No Discord token');
            this.sendChatMessage(null, from, "⚠️ You must login with Discord to use chat!");
            return;
        }

        if (!hasMinLevel) {
            // Not enough level - need to grind first
            Logger.debug('[CHAT-CHECK] ❌ REJECTED - Level too low');
            this.sendChatMessage(null, from, "⚠️ You need Level 2 or higher to use chat!");
            return;
        }

        Logger.debug('[CHAT-CHECK] ✅ PASSED - Allowed to chat');
    }

    if (message.length > 64) {
        message = message.slice(0, 64);
    }
    if (this.config.serverChatAscii) {
        for (var i = 0; i < message.length; i++) {
            if ((message.charCodeAt(i) < 0x20 || message.charCodeAt(i) > 0x7F) && from) {
                this.sendChatMessage(null, from, "You can use ASCII text only!");
                return;
            }
        }
    }
    if (this.checkBadWord(message) && from) {
        this.sendChatMessage(null, from, "Stop insulting others! Keep calm and be friendly please");
        return;
    }

    // ========================================
    // LUKA AI LEARNING SYSTEM
    // Observe ALL chat messages for self-learning
    // Luka watches chat and adds quality messages to dataset
    // ========================================
    if (this.config.lukaAI && from) {
        LukaAI.observeChat(from._name || 'Unknown', message);
    }

    // ========================================
    // LUKA AI INTEGRATION
    // Handle "hey luka" chat messages with AI responses
    // - Configurable cooldown per player (default 30s)
    // - Messages processed one at a time (queue)
    // - Enable/disable via config.lukaAI
    // ========================================
    if (this.config.lukaAI && from && LukaAI.isLukaRequest(message)) {
        var lukaResult = LukaAI.handleRequest(this, from, message, this.config.lukaAICooldown || 30);

        if (lukaResult.handled) {
            if (lukaResult.blocked && lukaResult.cooldownMessage) {
                // Player on cooldown or empty question
                // Create Luka sender with pID 32000 (pink color, player-style message)
                var lukaSender = {
                    pID: 32000, // Reserved Luka pID
                    _name: 'luka',
                    _skin: '',
                    cells: [{ color: { r: 255, g: 105, b: 180 } }], // Pink
                    color: { r: 255, g: 105, b: 180 },
                    nameColorEnabled: true,
                    nameColor: '#FF69B4',
                    badgeId: 0,
                    isBot: false,
                    userRole: 0
                };

                // Force send PlayerInfo to this client (bypass _initialWorldSent check)
                if (from.socket && from.socket.packetHandler && from.socket.packetHandler.isVanis) {
                    try {
                        var VanisWriter = require('./packet/VanisWriter');
                        var writer = new VanisWriter();
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
                        from.socket.send(writer.finalize());
                    } catch (e) {
                        // Fallback
                        if (typeof from.socket.packetHandler.sendVanisPlayerInfo === 'function') {
                            from.socket.packetHandler.sendVanisPlayerInfo(lukaSender);
                        }
                    }
                }

                // Send private message ONLY to this player
                this.sendChatMessage(lukaSender, from, lukaResult.cooldownMessage);
                return; // Don't broadcast the "hey luka" message
            }
            // Not blocked - broadcast their message, LukaAI will respond async
            this.sendChatMessage(from, to, message);
            return;
        }
    }

    this.sendChatMessage(from, to, message);
};

GameServer.prototype.checkBadWord = function (value) {
    if (!value) return false;
    value = value.toLowerCase().trim();
    if (!value) return false;
    for (var i = 0; i < this.badWords.length; i++) {
        if (value.indexOf(this.badWords[i]) >= 0) {
            return true;
        }
    }
    return false;
};

GameServer.prototype.sendChatMessage = function (from, to, message) {
    var sentCount = 0;
    var skippedTag = 0;
    var skippedFilter = 0;

    // Tournament spectator chat filter check
    var tm = this.tournamentManager;
    var filterActive = tm && tm.isActive && tm.filterSpectatorChat;
    var roundInProgress = tm && tm.isActive && tm.roundStarted && !tm.isFrozen;

    // Check if sender is a spectator (not in any team)
    var senderIsSpectator = false;
    if (filterActive && from && from.discordId) {
        var senderTeam = tm.getPlayerTeam(from.discordId);
        senderIsSpectator = (senderTeam === null);
    }

    for (var i = 0, len = this.clients.length; i < len; i++) {
        var client = this.clients[i];
        if (!client || !client.playerTracker) continue;
        if (!client.isConnected) continue; // Skip disconnected clients

        // Skip if this is a targeted message and not the target
        if (to && to !== client.playerTracker) continue;

        // TOURNAMENT SPECTATOR FILTER
        // If filter is active AND round is in progress AND sender is spectator
        // Don't send to tournament players (only spectators can see spectator messages)
        if (filterActive && senderIsSpectator && roundInProgress) {
            var receiverTeam = null;
            if (client.playerTracker.discordId) {
                receiverTeam = tm.getPlayerTeam(client.playerTracker.discordId);
            }

            // If receiver is a tournament player (has a team), skip
            if (receiverTeam !== null) {
                skippedFilter++;
                continue;
            }
        }

        // Tag isolation - check if this client can see the sender
        if (from && typeof client.playerTracker.canSeePlayerByTag === 'function' &&
            !client.playerTracker.canSeePlayerByTag(from)) {
            skippedTag++;
            continue; // Skip - can't see sender due to tag isolation
        }

        // Use Vanis chat for Vanis clients, legacy packet for others
        if (client.packetHandler && client.packetHandler.isVanis) {
            client.packetHandler.sendVanisChat(from, message);
            sentCount++;
        } else if (client.sendPacket) {
            client.sendPacket(new Packet.ChatMessage(from, message));
            sentCount++;
        }
    }

    // Debug log for chat broadcast
    if (from) {
        var filterLog = skippedFilter > 0 ? ', filtered ' + skippedFilter : '';
        Logger.debug('[CHAT] Message from PID=' + from.pID + ' sent to ' + sentCount + ' clients (skipped ' + skippedTag + ' by tag' + filterLog + ')');
    }
};


GameServer.prototype.timerLoop = function () {
    // HIBERNATION: Use slower tick rate when sleeping
    var timeStep = this.isHibernating ? this.hibernationTickRate : this.normalTickRate;

    var ts = Date.now();
    var dt = ts - this.timeStamp;
    if (dt < timeStep - 5) {
        setTimeout(this.timerLoopBind, ((timeStep - 5) - dt) >> 0);
        return;
    }
    if (dt > 120 && !this.isHibernating) this.timeStamp = ts - timeStep;
    // update average
    this.updateTimeAvg += 0.5 * (this.updateTime - this.updateTimeAvg);
    // calculate next
    if (!this.timeStamp)
        this.timeStamp = ts;
    this.timeStamp += timeStep;
    setTimeout(this.mainLoopBind, 0);
    setTimeout(this.timerLoopBind, 0);
};

GameServer.prototype.mainLoop = function () {
    this.stepDateTime = Date.now();
    var sw = this.stopwatch;
    var self = this;
    sw.begin();

    this.leaderboardChanged = false;

    // =====================================
    // DETAILED PROFILER INIT - Must be BEFORE updateClients for PlayerTracker tracking
    // =====================================
    var profilerEnabled = this.config.collisionOptimization || this.config.optimizationLogOnly;
    if (profilerEnabled && !this.detailedProfiler) {
        this.detailedProfiler = {
            // Section timings (ms)
            movingNodes: 0, collision: 0, playerCells: 0,
            spawn: 0, cleanup: 0, clients: 0, total: 0, count: 0,
            // Cell counts
            cellCount: 0, ejectedCount: 0, playerCount: 0, movingCount: 0,
            // Moving nodes breakdown
            movingBoostCell: 0, movingQuadFind: 0, movingRigidResolve: 0,
            movingEatResolve: 0, movingQuadUpdate: 0,
            movingRigidCount: 0, movingEatCount: 0,
            // Nodes player breakdown
            playerSorting: 0, playerQuadFind: 0, playerEatCollect: 0,
            playerEatResolve: 0, playerRigidResolve: 0, playerSortSkipped: 0,
            // Collision optimization stats
            inlineDistanceSkips: 0, inlineDelaySkips: 0, inlineSizeSkips: 0,
            eatCollisionsCollected: 0,
            // Resolve stats
            resolveCallCount: 0, resolveTotal: 0,
            // Eating results
            eatSuccess: 0, eatFailDistance: 0, eatFailSpawnProtect: 0,
            eatFailOwner: 0, eatFailSize: 0, eatFailCanEat: 0,
            // Bandwidth stats
            bytesSent: 0, packetsSent: 0, clientUpdates: 0,
            leaderboardSends: 0, avgPacketSize: 0, vanisWorldUpdates: 0,
            // PlayerTracker stats
            splitCount: 0, ejectCount: 0, viewportQueries: 0,
            viewNodesTotal: 0, spectatorCount: 0, updateTickCalls: 0
        };
    }

    // =====================================
    // HIBERNATION MODE - Skip heavy processing
    // Only handle new connections, everything else is paused
    // =====================================
    if (this.isHibernating) {
        // Minimal processing during hibernation
        // Just update clients (for connection handling) and return
        this.updateClients();
        this.tickCounter++;

        // End stopwatch
        this.updateTime = sw.stop();
        return;
    }

    // Loop main functions
    if (this.run) {
        var i = 0, l = this.movingNodes.length,
            cell,
            client,
            processedRigids = 0,
            processedEats = 0;

        // Moving nodes moving
        for (; i < l; i++) {
            cell = this.movingNodes[i];
            this.boostCell(cell);
            // Skip if cell was removed (e.g. ejected mass killed by border)
            if (cell.isRemoved || !cell.position) {
                i--;
                l--;
                continue;
            }
            this.updateNodeQuad(cell);
            if (!cell.isMoving) {
                i--;
                l--;
            }
        }

        this.updateTimes.t1 = sw.lap();

        // Profiler timing
        var profilerEnabled = this.config.optimizationLogOnly;
        var startTick = profilerEnabled ? process.hrtime() : null;

        // movingNodes collision (squared distance optimization)
        for (i = 0; i < l; i++) {
            cell = this.movingNodes[i];
            if (!cell || cell.isDead) continue;

            this.finder.find(cell.quadItem.bound, function (check) {
                if (cell.isRemoved || check.cell.isRemoved) return;
                if (cell.isDead) return;
                if (check.cell.cellType === 0 || check.cell.cellType === 1) return;
                if (check.cell === cell) return;

                var dx = check.cell.position.x - cell.position.x;
                var dy = check.cell.position.y - cell.position.y;
                var distSq = dx * dx + dy * dy;

                if (cell.cellType === 3 && check.cell.cellType === 3 && !self.config.mobilePhysics) {
                    var rSum = cell._size + check.cell._size;
                    if (distSq >= rSum * rSum) return;

                    var d = Math.sqrt(distSq);
                    var m = { cell: cell, check: check.cell, d: d, dx: dx, dy: dy };
                    self.resolveRigidCollision(m);
                    processedRigids++;
                } else {
                    var r1 = cell._size, r2 = check.cell._size;
                    var big = r1 > r2 ? r1 : r2;
                    var small = r1 > r2 ? r2 : r1;
                    var reqDist = big - small / self.config.playerEatOverlap;

                    if (distSq >= reqDist * reqDist) return;

                    var d = Math.sqrt(distSq);
                    var m = { cell: cell, check: check.cell, d: d, dx: dx, dy: dy };
                    self.resolveCollision(m);
                    processedEats++;
                }

                if (check.cell.isRemoved && check.cell.isMoving) { i--; l--; }
            });

            if (cell.isRemoved) { i--; l--; }
        }

        this.updateTimes.pmr = processedRigids;
        this.updateTimes.pme = processedEats;
        this.updateTimes.t2 = sw.lap();

        // Player cell collision & eating
        l = this.nodesPlayer.length;

        // nodesPlayer collision (squared distance optimization)
        for (i = 0; i < l; i++) {
            cell = this.nodesPlayer[i];
            if (!cell || !cell.owner || cell.isDead || cell.isRemoved) continue;
            client = cell.owner;

            this.finder.find(cell.quadItem.bound, function (check) {
                var checkCell = check.cell;
                if (cell.isRemoved || checkCell.isRemoved) return;
                if (cell.isDead || checkCell === cell) return;

                var dx = checkCell.position.x - cell.position.x;
                var dy = checkCell.position.y - cell.position.y;
                var distSq = dx * dx + dy * dy;
                var r1 = cell._size, r2 = checkCell._size;

                // Early exit: distSq > (r1+r2)² or same size
                var sumSize = r1 + r2;
                if (distSq > sumSize * sumSize || r1 === r2) return;

                var d = Math.sqrt(distSq);
                var m = { cell: cell, check: checkCell, d: d, dx: dx, dy: dy };

                if (!self.checkRigidCollision(m)) {
                    self.resolveCollision(m);
                    if (checkCell.isRemoved && checkCell.cellType === 0) { i--; l--; }
                    processedEats++;
                }
            });
            if (cell.isRemoved) { i--; l--; }
        }

        this.updateTimes.ppr = processedRigids;
        this.updateTimes.ppe = processedEats;

        this.updateTimes.t3 = sw.lap();

        processedRigids = 0;
        processedEats = 0;

        // Player cell moving, decay, remerge recalc & autosplit
        l = this.nodesPlayer.length;
        
        this.nodesPlayer.sort(function (a, b) {
            var massDiff = b._mass - a._mass;
            if (massDiff !== 0) return massDiff;
            return a.birthTick - b.birthTick; // oldest first
        });

        // Collect rigid collisions for Center of Mass resolution (if enabled)
        // This fixes that jittery superposition bullshit when cells stack up
        var rigidCollisions = [];

        for (i = 0; i < l; i++) {
            cell = this.nodesPlayer[i];

            // Safety check - cell might be undefined if array was modified
            if (!cell) continue;

            client = cell.owner;

            if (!cell.owner || client.frozen || cell.isDead)
                continue;
            
            if (client.cells.length > 1) { // just in case
                client.cells.sort(function (a, b) {
                    var massDiff = b._mass - a._mass;
                    if (massDiff !== 0) return massDiff;
                    return a.birthTick - b.birthTick;
                });
            }

            // Check if this player should use Center of Mass collision
            // If player has more than centerOfMassMaxCells, use standard collision (prevents merge delays)
            var shouldUseCOM = self.config.useCenterOfMassCollision &&
                client.cells.length <= self.config.centerOfMassMaxCells;

            // Move player cells
            this.updateRemerge(cell, client);
            this.boostCell(cell);
            this.movePlayer(cell, client);

            // Check if cell was killed by border
            if (cell._borderKilled) {
                cell._borderKilled = false; // Reset flag
                this.convertCellToDeadCell(cell); // Convert to dead cell
                i--; l--; // Array modified, adjust indices
                continue; // Skip further processing of this cell
            }

            this.autoSplit(cell, client);

            this.finder.find(cell.quadItem.bound, function (check) {
                if (check.cell === cell) return;
                var m = self.checkCellCollision(cell, check.cell);
                if (self.checkRigidCollision(m)) {
                    if (shouldUseCOM) {
                        // Collect for batch resolution - don't resolve yet
                        rigidCollisions.push({ manifold: m, cell: cell, check: check.cell });
                    } else {
                        // Standard immediate resolution
                        self.resolveRigidCollision(m);
                        processedEats++;
                    }
                }
            });

            // decay every tick
            this.updateMassDecay(cell);

            this.updateNodeQuad(cell);
        }

        // Resolve collected rigid collisions using Center of Mass
        // This resolves from center outward, preventing that shitty jitter
        if (this.config.useCenterOfMassCollision && rigidCollisions.length > 0) {
            this.resolveCenterOfMassRigidCollisions(rigidCollisions);
            processedEats += rigidCollisions.length;
        }

        this.updateTimes.t4 = sw.lap();

        // Spawn food & viruses
        var sp = this.config.foodAmount - this.nodesFood.length;
        while (sp > 0) {
            this.spawnFood();
            sp--;
        }
        sp = this.config.virusMinAmount - this.nodesVirus.length;
        while (sp > 0) {
            this.spawnVirus();
            sp--;
        }

        this.updateTimes.t5 = sw.lap();

        // Remove old ejected mass (auto-decay after ejectMaxAge ticks)
        // This keeps the map clean and prevents mass hoarding
        if (this.config.ejectMaxAge > 0) {
            for (i = 0; i < this.nodesEjected.length;) {
                cell = this.nodesEjected[i];
                if (cell && cell.getAge() >= this.config.ejectMaxAge) {
                    this.removeNode(cell);
                } else {
                    i++;
                }
            }
        }

        // Clean up dead cells after their timeout
        // Dead cells are corpses from respawning players
        var deadDelay = this.config.playerDeadDelay || 75; // 3 seconds default
        for (i = 0; i < this.nodes.length;) {
            cell = this.nodes[i];
            if (cell && cell.isDead) {
                var ticksAlive = this.tickCounter - cell.deadTick;
                if (ticksAlive >= deadDelay) {
                    // Dead cell expired, yeet it out of existence
                    this.removeNode(cell);
                    continue; // Don't increment i since we removed an item
                }
            }
            i++;
        }
    }

    this.gameMode.onTick(this);

    // Tournament system tick - update timers, check for eliminations, etc
    if (this.tournamentManager) {
        this.tournamentManager.onTick();
    }

    // Border shrinking - Works in both tournament AND normal modes
    // If borderShrinkEnabled is set, border will shrink over time
    // BUT: In tournament mode, ONLY shrink when round is actively running (not frozen/paused)
    if (this.config.borderShrinkEnabled && this.run) {
        // Tournament mode check - only shrink when round is ACTIVE (not during lobby/waiting)
        var shouldShrink = true;
        if (this.tournamentManager && this.tournamentManager.isActive) {
            // Tournament is active - only shrink if:
            // 1. Round has started (roundStarted = true)
            // 2. Not frozen (isFrozen = false) 
            // 3. Not paused (isPaused = false)
            shouldShrink = this.tournamentManager.roundStarted &&
                !this.tournamentManager.isFrozen &&
                !this.tournamentManager.isPaused;

            // Debug log for troubleshooting
            if (!shouldShrink && this._borderShrinkDebugLogged !== this.tickCounter) {
                this._borderShrinkDebugLogged = this.tickCounter;
                // Only log once per second (every 25 ticks)
                if (this.tickCounter % 25 === 0) {
                    Logger.debug('[BORDER-SHRINK] Waiting for tournament round to start. roundStarted=' +
                        this.tournamentManager.roundStarted + ', frozen=' + this.tournamentManager.isFrozen +
                        ', paused=' + this.tournamentManager.isPaused);
                }
            }

            // RESET shrink state when round is NOT active (frozen/paused/ended)
            // This ensures each new round starts with fresh border shrink from original size
            if (!shouldShrink && this._borderShrinkInitialized !== undefined) {
                // Round ended or paused - clear shrink state so next round starts fresh
                this._borderShrinkInitialized = undefined;
                this._currentBorderSize = undefined;
                this._originalBorderSize = undefined;
                this._borderShrinkStartTime = undefined;
                this._borderShrinkLastTick = undefined;
                this._lastBorderUpdateTick = undefined;
                Logger.debug('[BORDER-SHRINK] State cleared - will reinitialize when round starts');
            }
        }

        if (shouldShrink) {
            // Initialize border shrinking on first tick if not done yet
            if (this._borderShrinkInitialized === undefined) {
                this._borderShrinkInitialized = true;
                this._borderShrinkStartTime = Date.now();
                this._borderShrinkLastTick = Date.now();

                // RESET border to original size BEFORE starting shrink
                // This ensures each round starts with full-size border
                if (this.resetBorderToOriginal) {
                    this.resetBorderToOriginal();
                }

                // Store original size (after reset)
                if (this.config.worldIsCircular) {
                    this._originalBorderSize = this.config.worldRadius;
                } else {
                    this._originalBorderSize = Math.min(this.border.width, this.border.height);
                }
                this._currentBorderSize = this._originalBorderSize;
                this._lastBorderUpdateTick = 0;
                Logger.info('[BORDER-SHRINK] Round started - Border reset to original and shrink initialized. Size: ' + this._originalBorderSize);
            }

            // Update border shrinking every tick
            var now = Date.now();
            var elapsed = (now - this._borderShrinkLastTick) / 1000;
            this._borderShrinkLastTick = now;

            // Calculate shrink amount
            var shrinkAmount = this.config.borderShrinkSpeed * elapsed;
            var newSize = this._currentBorderSize - shrinkAmount;
            var minSize = this.config.borderShrinkMinSize;

            // Don't shrink below minimum
            if (newSize > minSize) {
                this._currentBorderSize = newSize;

                // Throttle updates - only send every 10 ticks
                if (this.tickCounter - this._lastBorderUpdateTick >= 10) {
                    this._lastBorderUpdateTick = this.tickCounter;

                    // Update the actual game border
                    if (this.config.worldIsCircular) {
                        var newWidth = newSize * 2;
                        var newHeight = newSize * 2;
                        Logger.debug('[BORDER-SHRINK] Circular: radius=' + Math.floor(newSize));
                        this.updateBorderSize(newWidth, newHeight, newSize);
                    } else {
                        var ratio = newSize / this._originalBorderSize;
                        var newWidth = this.originalBorder.width * ratio;
                        var newHeight = this.originalBorder.height * ratio;
                        Logger.debug('[BORDER-SHRINK] Rectangular: ' + Math.floor(newWidth) + 'x' + Math.floor(newHeight));
                        this.updateBorderSize(newWidth, newHeight);
                    }
                }
            } else if (this._currentBorderSize > minSize) {
                // Hit minimum - announce once
                this._currentBorderSize = minSize;
                Logger.info('[BORDER-SHRINK] Reached minimum size: ' + minSize);
            }
        }
    }

    this.updateTimes.t6 = sw.lap();

    // =====================================
    // WINNER SYSTEM - Check for mass threshold victory
    // =====================================
    if (!this.isRestarting && this.config.serverMaxMassWin > 0) {
        for (i = 0; i < this.clients.length; i++) {
            client = this.clients[i];
            if (!client.playerTracker || client.playerTracker.cells.length === 0)
                continue;

            var totalMass = 0;
            for (var j = 0; j < client.playerTracker.cells.length; j++)
                totalMass += client.playerTracker.cells[j]._mass;

            if (totalMass >= this.config.serverMaxMassWin) {
                // Player reached win threshold
                if (!this.winnerCountdownActive) {
                    // Start new countdown
                    this.winnerCountdownActive = true;
                    this.winnerCountdownStartTick = this.tickCounter;
                    this.winnerPlayer = client.playerTracker;
                    this.winnerName = client.playerTracker._name;
                    this.lastWinnerMessageTick = this.tickCounter;
                    this.isRestarting = true; // Prevent other win detections

                    Logger.info("[GAME] " + this.winnerName + " reached win threshold! Countdown started.");
                    this.sendWinnerMessage(this.winnerName, 5);
                }
                break; // Only one winner at a time
            }
        }
    }

    // Monitor active winner countdown
    if (this.winnerCountdownActive && this.winnerPlayer) {
        // Check if winner still exists and has cells
        if (!this.winnerPlayer || this.winnerPlayer.isRemoved || !this.winnerPlayer.cells.length) {
            // Winner died or disconnected - cancel countdown
            Logger.info("[GAME] Winner died/disconnected. Countdown cancelled.");
            this.cancelWinnerCountdown();
        } else {
            // Calculate winner's current total mass
            var winnerMass = 0;
            for (var j = 0; j < this.winnerPlayer.cells.length; j++) {
                winnerMass += this.winnerPlayer.cells[j]._mass;
            }

            // Check if mass dropped below threshold
            if (winnerMass < this.config.serverMaxMassWin) {
                Logger.info("[GAME] Winner mass dropped below threshold (" + Math.round(winnerMass) + " < " + this.config.serverMaxMassWin + "). Countdown cancelled.");
                this.cancelWinnerCountdown();
            } else {
                // Winner still qualifies - check countdown progress
                var ticksElapsed = this.tickCounter - this.winnerCountdownStartTick;
                var secondsElapsed = Math.floor(ticksElapsed / 25); // 25 ticks = 1 second
                var secondsRemaining = 5 - secondsElapsed;

                // Send message every second (every 25 ticks)
                var currentMessageTick = Math.floor(this.tickCounter / 25);
                var lastMessageTick = Math.floor(this.lastWinnerMessageTick / 25);

                if (currentMessageTick > lastMessageTick && secondsRemaining >= 0) {
                    this.sendWinnerMessage(this.winnerName, secondsRemaining);
                    this.lastWinnerMessageTick = this.tickCounter;
                }

                // Execute restart after 5 seconds (130 ticks for safety)
                if (ticksElapsed >= 130) {
                    Logger.info("[GAME] Countdown finished, executing restart...");
                    this.winnerCountdownActive = false;
                    this.isRestarting = false; // Reset before calling executeRestart
                    this.executeRestart();
                }
            }
        }
    }

    // update leaderboard
    if (((this.tickCounter + 3) % 8) === 0) {
        this.updateLeaderboard();
        this.updateTimes.t7 = sw.lap();
    }

    this.updateClients();
    this.updateTimes.t8 = sw.lap();

    // update internet usage
    if ((this.tickCounter % 25) === 0) {
        this.uploadAvg = this.uploadAvg * .5 + this.uploadUsage * .5;
        this.downloadAvg = this.downloadAvg * .5 + this.downloadUsage * .5;
        this.uploadUsage = this.downloadUsage = 0;
    }

    // ping server tracker
    if (this.config.serverTracker && (this.tickCounter % 750) === 0)
        this.pingServerTracker(); // once per 30 seconds

    // Clean up expired captcha tokens (every 750 ticks = 30 seconds)
    if ((this.tickCounter % 750) === 0) {
        if (this.hcaptcha) {
            this.hcaptcha.cleanupExpiredTokens();
        }
    }

    // update-update time
    this.updateTimes.t9 = sw.lap();
    this.updateTime = sw.elapsed();
    sw.stop();

    // =====================================
    // DETAILED PROFILER LOGGING
    // Track each section of mainLoop
    // =====================================
    if (profilerEnabled && this.detailedProfiler && startTick) {
        var totalEnd = process.hrtime(startTick);
        var totalMs = (totalEnd[0] * 1e9 + totalEnd[1]) / 1e6;

        // Accumulate times
        var dp = this.detailedProfiler;
        dp.total += totalMs;
        dp.count++;
        dp.cellCount += this.nodes.length;
        dp.ejectedCount += this.nodesEjected.length;
        dp.playerCount += this.nodesPlayer.length;
        dp.movingCount += this.movingNodes.length;

        // Calculate section times from updateTimes
        if (this.updateTimes) {
            dp.movingNodes += this.updateTimes.t1 || 0;
            dp.collision += (this.updateTimes.t3 || 0) - (this.updateTimes.t1 || 0);
            dp.playerCells += (this.updateTimes.t4 || 0) - (this.updateTimes.t3 || 0);
            dp.spawn += (this.updateTimes.t5 || 0) - (this.updateTimes.t4 || 0);
            dp.cleanup += (this.updateTimes.t9 || 0) - (this.updateTimes.t5 || 0);
            dp.clients += this.updateTimes.t8 || 0;
            // Collision counts from mainLoop
            dp.movingRigidCount += this.updateTimes.pmr || 0;
            dp.movingEatCount += this.updateTimes.pme || 0;
        }

        // Log every 75 ticks (3 seconds at 25 TPS)
        if (this.tickCounter % 75 === 0 && dp.count > 0) {
            var avg = function (v) { return (v / dp.count).toFixed(2); };
            var avgCount = function (v) { return Math.round(v / dp.count); };
            var total = function (v) { return v || 0; };
            var pct = function (part, whole) { return whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '0%'; };

            // Use direct console output if optimizationLogOnly is enabled (bypasses logVerbosity)
            var useDirectOutput = this.config.optimizationLogOnly === 1;
            var log = useDirectOutput ? function (msg) { process.stdout.write(msg + '\n'); } : Logger.info.bind(Logger);

            log('[PROFILER] ════════════════════════════════════════════════════════════════');
            log('[PROFILER]   TICK BREAKDOWN (over ' + dp.count + ' ticks, avg ' + avg(dp.total) + 'ms/tick)');
            log('[PROFILER] ────────────────────────────────────────────────────────────────');
            log('[PROFILER]   Moving Nodes:  ' + avg(dp.movingNodes) + 'ms  (' + pct(dp.movingNodes, dp.total) + ')');
            log('[PROFILER]   Collision:     ' + avg(dp.collision) + 'ms  (' + pct(dp.collision, dp.total) + ')');
            log('[PROFILER]   Player Cells:  ' + avg(dp.playerCells) + 'ms  (' + pct(dp.playerCells, dp.total) + ')');
            log('[PROFILER]   Spawn:         ' + avg(dp.spawn) + 'ms');
            log('[PROFILER]   Cleanup:       ' + avg(dp.cleanup) + 'ms');
            log('[PROFILER]   Clients:       ' + avg(dp.clients) + 'ms');
            log('[PROFILER] ────────────────────────────────────────────────────────────────');
            log('[PROFILER]   CELL COUNTS (per tick): ' + avgCount(dp.cellCount) + ' total, ' +
                avgCount(dp.playerCount) + ' player, ' + avgCount(dp.ejectedCount) + ' ejected, ' +
                avgCount(dp.movingCount) + ' moving');

            // Collision optimization stats (only when enabled)
            if (this.config.collisionOptimization) {
                // MovingNodes breakdown
                log('[PROFILER] ────────────────────────────────────────────────────────────────');
                log('[PROFILER]   MOVING NODES: ' + avgCount(dp.movingCount) + ' cells/tick');
                log('[PROFILER]     Rigid collisions: ' + avgCount(dp.movingRigidCount) + '/tick');
                log('[PROFILER]     Eat collisions:   ' + avgCount(dp.movingEatCount) + '/tick');

                // NodesPlayer breakdown
                log('[PROFILER] ────────────────────────────────────────────────────────────────');
                log('[PROFILER]   NODES PLAYER: ' + avgCount(dp.playerCount) + ' cells/tick');
                log('[PROFILER]     Sort skipped: ' + total(dp.playerSortSkipped) + ' times');

                // Inline skip stats
                log('[PROFILER] ────────────────────────────────────────────────────────────────');
                log('[PROFILER]   INLINE SKIPS (per tick):');
                log('[PROFILER]     Distance:  ' + avgCount(dp.inlineDistanceSkips) + ' (çok uzak - EN ÇOK ELEME)');
                log('[PROFILER]     Size:      ' + avgCount(dp.inlineSizeSkips) + ' (aynı boyut)');
                log('[PROFILER]     Delay:     ' + avgCount(dp.inlineDelaySkips) + ' (collision delay)');
                log('[PROFILER]     → Collected: ' + avgCount(dp.eatCollisionsCollected) + ' (resolveCollision\'a giden)');

                // Resolve stats
                log('[PROFILER] ────────────────────────────────────────────────────────────────');
                log('[PROFILER]   RESOLVE COLLISION: ' + total(dp.resolveCallCount) + ' calls (' + avgCount(dp.resolveCallCount) + '/tick)');

                // Eating results  
                log('[PROFILER] ────────────────────────────────────────────────────────────────');
                log('[PROFILER]   EATING RESULTS (' + dp.count + ' ticks):');
                log('[PROFILER]     ✓ Success:     ' + total(dp.eatSuccess) + ' (' + avgCount(dp.eatSuccess) + '/tick)');
                log('[PROFILER]     ✗ Distance:    ' + total(dp.eatFailDistance) + ' (mesafe yetersiz)');
                log('[PROFILER]     ✗ SpawnProt:   ' + total(dp.eatFailSpawnProtect) + ' (spawn protection)');
                log('[PROFILER]     ✗ Owner/Delay: ' + total(dp.eatFailOwner) + ' (same owner delay)');
                log('[PROFILER]     ✗ Size:        ' + total(dp.eatFailSize) + ' (boyut farkı < eatMult)');
                log('[PROFILER]     ✗ canEat:      ' + total(dp.eatFailCanEat) + ' (canEat false)');
            }

            // Bandwidth stats (always show)
            var bytesPerSec = Math.round((dp.bytesSent || 0) / 3); // 3 seconds period
            var packetsPerSec = Math.round((dp.packetsSent || 0) / 3);
            var avgPktSize = dp.packetsSent > 0 ? Math.round(dp.bytesSent / dp.packetsSent) : 0;
            var kbPerSec = (bytesPerSec / 1024).toFixed(2);
            var clientCount = this.clients.length || 1;
            var bytesPerClient = Math.round((dp.bytesSent || 0) / clientCount / 3);
            var updatesPerTick = dp.count > 0 ? (dp.clientUpdates / dp.count).toFixed(1) : 0;

            log('[PROFILER] ────────────────────────────────────────────────────────────────');
            log('[PROFILER]   BANDWIDTH (3 saniye):');
            log('[PROFILER]     Total:       ' + bytesPerSec + ' B/s (' + kbPerSec + ' KB/s)');
            log('[PROFILER]     Per client:  ' + bytesPerClient + ' B/s (' + (bytesPerClient / 1024).toFixed(2) + ' KB/s)');
            log('[PROFILER]     Packets/sec: ' + packetsPerSec + ' (avg ' + avgPktSize + ' bytes/packet)');
            log('[PROFILER]   CLIENT UPDATES:');
            log('[PROFILER]     Updates/tick: ' + updatesPerTick);
            log('[PROFILER]     Vanis:        ' + total(dp.vanisWorldUpdates || 0) + ' world updates (' + avgCount(dp.vanisWorldUpdates || 0) + '/tick)');
            log('[PROFILER]     Leaderboard:  ' + total(dp.leaderboardSends) + ' sends');
            log('[PROFILER]     Clients:      ' + clientCount + ' connected');
            // Debug sendUpdate skips
            if (dp.sendUpdateSkips) {
                log('[PROFILER]     ⚠️ SKIPS:     ' + total(dp.sendUpdateSkips) + ' (' + avgCount(dp.sendUpdateSkips) + '/tick)');
                if (dp.skipNoProtocol) log('[PROFILER]       - NoProtocol:   ' + total(dp.skipNoProtocol));
                if (dp.skipNotConnected) log('[PROFILER]       - NotConnected: ' + total(dp.skipNotConnected));
                if (dp.skipMinion) log('[PROFILER]       - Minion:       ' + total(dp.skipMinion));
                if (dp.skipMi) log('[PROFILER]       - isMi:         ' + total(dp.skipMi));
                if (dp.skipRemoved) log('[PROFILER]       - Removed:      ' + total(dp.skipRemoved));
                if (dp.skipNotWritable) log('[PROFILER]       - NotWritable:  ' + total(dp.skipNotWritable));
                if (dp.skipNotOpen) log('[PROFILER]       - NotOpen:      ' + total(dp.skipNotOpen));
            }
            // Packet sending debug
            log('[PROFILER]   PACKET SENDING DEBUG:');
            log('[PROFILER]     isConnected OK:  ' + total(dp.isConnectedPassed || 0) + ' (' + avgCount(dp.isConnectedPassed || 0) + '/tick)');
            log('[PROFILER]     isConnected FAIL:' + total(dp.isConnectedFailed || 0));
            log('[PROFILER]     isVanis OK:      ' + total(dp.isVanisPassed || 0) + ' (' + avgCount(dp.isVanisPassed || 0) + '/tick)');
            log('[PROFILER]     Legacy protocol: ' + total(dp.legacyProtocolUsed || 0));

            // PlayerTracker stats
            var avgViewNodes = dp.viewportQueries > 0 ? Math.round(dp.viewNodesTotal / dp.viewportQueries) : 0;
            log('[PROFILER] ────────────────────────────────────────────────────────────────');
            log('[PROFILER]   PLAYER TRACKER:');
            log('[PROFILER]     UpdateTick:   ' + total(dp.updateTickCalls) + ' calls (' + avgCount(dp.updateTickCalls) + '/tick)');
            log('[PROFILER]     Splits:       ' + total(dp.splitCount) + ' (' + avgCount(dp.splitCount) + '/tick)');
            log('[PROFILER]     Ejects:       ' + total(dp.ejectCount) + ' (' + avgCount(dp.ejectCount) + '/tick)');
            log('[PROFILER]     Spectators:   ' + avgCount(dp.spectatorCount) + '/tick');
            log('[PROFILER]     ViewNodes:    ' + avgViewNodes + ' avg per query');
            log('[PROFILER] ════════════════════════════════════════════════════════════════');

            // Reset profiler with all fields
            this.detailedProfiler = {
                // Section timings
                movingNodes: 0, collision: 0, playerCells: 0,
                spawn: 0, cleanup: 0, clients: 0,
                total: 0, count: 0,
                // Cell counts
                cellCount: 0, ejectedCount: 0, playerCount: 0, movingCount: 0,
                // Moving nodes breakdown
                movingBoostCell: 0, movingQuadFind: 0, movingRigidResolve: 0,
                movingEatResolve: 0, movingQuadUpdate: 0,
                movingRigidCount: 0, movingEatCount: 0,
                // Nodes player breakdown
                playerSorting: 0, playerQuadFind: 0, playerEatCollect: 0,
                playerEatResolve: 0, playerRigidResolve: 0, playerSortSkipped: 0,
                // Collision optimization stats
                inlineDistanceSkips: 0, inlineDelaySkips: 0, inlineSizeSkips: 0,
                eatCollisionsCollected: 0,
                // Resolve stats
                resolveCallCount: 0, resolveTotal: 0,
                // Eating results
                eatSuccess: 0, eatFailDistance: 0, eatFailSpawnProtect: 0,
                eatFailOwner: 0, eatFailSize: 0, eatFailCanEat: 0,
                // Bandwidth stats
                bytesSent: 0, packetsSent: 0, clientUpdates: 0,
                leaderboardSends: 0, avgPacketSize: 0, vanisWorldUpdates: 0,
                // PlayerTracker stats
                splitCount: 0, ejectCount: 0, viewportQueries: 0,
                viewNodesTotal: 0, spectatorCount: 0, updateTickCalls: 0
            };
        }
    }

    // Flush batch quad updates at tick end (when collisionOptimization enabled)
    if (this.config.collisionOptimization && this._pendingQuadUpdates.length > 0) {
        this._flushQuadUpdates();
    }

    // Flush collision logs at tick end (if collision logging is enabled)
    if (this.collisionLogPlayerIds.size > 0) {
        this._flushCollisionLogs();
    }

    this.tickCounter++;
};

// update remerge first - Luka's MultiOgar-Edited formula
// recombineTime > 0: Luka's formula, recombineTime = 0: noMergeDelay formula
GameServer.prototype.updateRemerge = function (cell, client) {
    var time = this.config.playerRecombineTime;

    // instant merging conditions (rec mode or merge override)
    if (client.rec || client.mergeOverride) {
        cell._canRemerge = cell.boostDistance < 100;
        return; // instant merge
    }

    // recombineTime > 0: Use Luka's formula
    if (time > 0) {
        // Luka's formula: base = max(recombineTime, cell._size * 0.2) * 25
        var base = Math.max(time, cell._size * 0.2) * 25;
        cell._canRemerge = cell.getAge() >= base;
    } else {
        // Use no_merge_delay when merge_time is 0 or negative
        // Dynamic nomergedelay based on player total mass
        var noMergeDelay = this.config.playerNoMergeDelay;

        // Only apply mass-based scaling if playerNoMergeDelayByMass is enabled
        // When disabled, just use the flat playerNoMergeDelay value
        if (client && this.config.playerNoMergeDelayByMass) {
            // Calculate total mass of all player cells
            var totalMass = 0;
            for (var i = 0; i < client.cells.length; i++) {
                if (client.cells[i]) {
                    totalMass += client.cells[i]._mass;
                }
            }

            // Check mass thresholds and apply appropriate nomergedelay
            if (totalMass >= this.config.playerNoMergeDelay3Mass) {
                noMergeDelay = this.config.playerNoMergeDelay3;
            } else if (totalMass >= this.config.playerNoMergeDelay2Mass) {
                noMergeDelay = this.config.playerNoMergeDelay2;
            } else if (totalMass >= this.config.playerNoMergeDelay1Mass) {
                noMergeDelay = this.config.playerNoMergeDelay1;
            }
        }

        cell._canRemerge = cell.getAge() > noMergeDelay;
    }
};


// decay yoinked from ogarx
GameServer.prototype.updateMassDecay = function (cell) {
    var size = cell._size;
    var decayMin = this.config.decayMin;

    // Get total player score (mass) for dynamic decay calculation
    var score = 0;
    if (cell.owner) {
        for (var i = 0; i < cell.owner.cells.length; i++) {
            var ownerCell = cell.owner.cells[i];
            if (!ownerCell) continue;
            score += ownerCell._mass;
        }
    } else {
        score = cell._mass;
    }


    // ensuring large players decay even when split
    var decayMinMass = decayMin * decayMin / 100;
    if (score <= decayMinMass) {
        return;
    }


    var staticDecay = this.config.staticDecay * 0.01;


    var dynamicDecay = this.config.dynamicDecay;
    var currMulti = (score - 0.01 * decayMin * decayMin) * 0.00005 * dynamicDecay;
    if (currMulti < 1.0) currMulti = 1.0;

    //25 tps
    var dt = 40.0;


    var decayAmount = currMulti * size * staticDecay * dt * 0.0001;

    // MAX DECAY MASS: If player total mass exceeds threshold, decay 50% faster
    // This prevents players from going above the mass cap
    var maxDecayMass = this.config.maxDecayMass;
    if (maxDecayMass > 0 && score > maxDecayMass) {
        // Apply 50% faster decay when above threshold
        decayAmount *= 1.5;
    }

    // Apply decay
    size -= decayAmount;


    // not the floor for individual cell size
    var minSize = this.config.playerMinSize;
    if (this.config.playerMinDecayMass && this.config.playerMinDecayMass > 0) {
        // Optional override: use mass-based floor
        minSize = Math.sqrt(this.config.playerMinDecayMass * 100);
    }
    size = Math.max(size, minSize);


    if (this.tickCounter % 250 === 0 && score > 300000) {
        Logger.debug('[DECAY-DEBUG] maxDecayMass=' + maxDecayMass + ', score=' + Math.round(score) + ', check=' + (maxDecayMass > 0 && score > maxDecayMass));
    }
    if (maxDecayMass > 0 && score > maxDecayMass) {
        Logger.warn('[DECAY-HARDCAP] TRIGGERED! maxDecayMass=' + maxDecayMass + ', score=' + Math.round(score));
        var maxSize = Math.sqrt(maxDecayMass * 100);
        // Calculate how much this cell should be (proportional to its share of total mass)
        var cellMassRatio = cell._mass / score;
        var targetCellMass = maxDecayMass * cellMassRatio;
        var targetCellSize = Math.sqrt(targetCellMass * 100);

        // If current size would keep us over cap, reduce it
        if (size > targetCellSize) {
            size = Math.max(targetCellSize, minSize);
        }
    }

    cell.setSize(size);
};

GameServer.prototype.boostCell = function (cell) {

    if (!cell || !cell.isMoving) return;

    // If boost is exhausted, stop moving
    if (!(cell.boostDistance > 0)) {
        cell.boostDistance = 0;
        cell.isMoving = false;
        return;
    }

    // OgarII-style LINEAR decay - snappier splits that stop cleanly
    // Classic /9 formula: consistent, predictable split distance
    // No more floaty exponential bullshit
    var d = cell.boostDistance;
    var db = d / 9;  // Classic OgarII style - linear decay

    if (!(db > 0)) {
        cell.boostDistance = 0;
        cell.isMoving = false;
        return;
    }
    // Safety clamp (numeric stability)
    if (db > d) db = d;

    cell.position.x += cell.boostDirection.x * db;
    cell.position.y += cell.boostDirection.y * db;
    cell.boostDistance = d - db;

    // COLLISION LOGGING: Log boost decay with mouse info
    if (db > 20 && cell.owner && this._shouldLogCollision(cell.owner.pID)) {
        var mouseX = cell.owner.mouse ? cell.owner.mouse.x : 0;
        var mouseY = cell.owner.mouse ? cell.owner.mouse.y : 0;
        var distToMouse = Math.sqrt(Math.pow(cell.position.x - mouseX, 2) + Math.pow(cell.position.y - mouseY, 2));
        this._addCollisionLog(cell.owner.pID, 'BOOST', {
            cellId: cell.nodeId,
            age: cell.getAge ? cell.getAge() : '?',
            boost: d.toFixed(0) + '→' + cell.boostDistance.toFixed(0),
            pos: '(' + cell.position.x.toFixed(0) + ',' + cell.position.y.toFixed(0) + ')',
            dir: '(' + cell.boostDirection.x.toFixed(2) + ',' + cell.boostDirection.y.toFixed(2) + ')',
            mouse: '(' + mouseX.toFixed(0) + ',' + mouseY.toFixed(0) + ')',
            distToMouse: distToMouse.toFixed(0)
        });
    }

    // reflect off of border (skip if borderKillsCells - let cells pass through)
    if (!this.config.borderKillsCells) {
        // Engine bounceCell equivalent:
        // strict: use radius; non-strict: use radius/2
        var margin = this.config.borderStrict ? cell._size : (cell._size / 2);

        if (this.config.worldIsCircular) {
            // Simple circular bounce: if outside maxDistance, flip direction and clamp back
            var radius = this.config.worldRadius;
            var maxDistance = radius - margin;
            var x = cell.position.x;
            var y = cell.position.y;
            var dist = Math.sqrt(x * x + y * y);
            if (dist > maxDistance) {
                // Reflect direction roughly back inward
                cell.boostDirection.x = -cell.boostDirection.x;
                cell.boostDirection.y = -cell.boostDirection.y;
            }
        } else {
            if (cell.position.x < this.border.minx + margin || cell.position.x > this.border.maxx - margin)
                cell.boostDirection.x = -cell.boostDirection.x;
            if (cell.position.y < this.border.miny + margin || cell.position.y > this.border.maxy - margin)
                cell.boostDirection.y = -cell.boostDirection.y;
        }
    }
    cell.checkBorder(this.border);

    // Check if ejected cell was killed by border - just reset flag, don't delete
    if (cell._borderKilled && cell.cellType === 3) {
        cell._borderKilled = false; // Reset flag but keep the ejected mass alive
    }

    // Engine stops boosting when d is nearly exhausted.
    // Use <= 1 to match engine's "d <= 1 => stop" behavior (in our units).
    if (cell.boostDistance <= 1) {
        cell.boostDistance = 0;
        cell.isMoving = false;

        // Remove from movingNodes - use O(1) when optimization enabled
        if (this.config.collisionOptimization && cell._movingIndex !== undefined && cell._movingIndex < this.movingNodes.length) {
            var lastMoving = this.movingNodes[this.movingNodes.length - 1];
            if (lastMoving !== cell) {
                this.movingNodes[cell._movingIndex] = lastMoving;
                lastMoving._movingIndex = cell._movingIndex;
            }
            this.movingNodes.pop();
            cell._movingIndex = undefined;
        } else {
            // Original O(n) removal
            var i = this.movingNodes.indexOf(cell);
            if (i !== -1) this.movingNodes.splice(i, 1);
        }
        return;
    }
};

GameServer.prototype.movePlayer = function (cell, client) {
    // Tournament freeze check - stop movement if frozen
    if (client.frozen) return;

    // get distance (Luka's MultiOgar-Edited formula)
    var dx = ~~(client.mouse.x - cell.position.x);
    var dy = ~~(client.mouse.y - cell.position.y);
    var d = Math.sqrt(dx * dx + dy * dy);
    // get movement speed
    var move = cell.getSpeed(d);
    if (!move) return; // avoid jitter
    // move player cells
    cell.position.x += dx * move;
    cell.position.y += dy * move;

    // ensure cell stays within map boundaries
    cell.checkBorder(this.border);
};

GameServer.prototype.autoSplit = function (cell, client) {
    // OgarX-style autosplit (when playerAutoSplitSize > 0)
    // This splits cells into equal pieces when they exceed a threshold
    if (this.config.playerAutoSplitSize > 0) {
        var autoSize = this.config.playerAutoSplitSize;
        var autoDelay = this.config.playerAutoSplitDelay / 40; // Convert ms to ticks (40ms per tick)

        // Track when cell first exceeded autosplit size
        if (cell._size >= autoSize) {
            if (cell.autoSplitEligibleTick === undefined || cell.autoSplitEligibleTick === -1) {
                // First time exceeding threshold, record the tick
                cell.autoSplitEligibleTick = this.tickCounter;
            }
        } else {
            // Reset if cell shrinks below threshold
            cell.autoSplitEligibleTick = -1;
        }

        // Check if cell is eligible and delay has passed
        if (cell._size < autoSize || cell.autoSplitEligibleTick === -1) return;
        var ticksSinceEligible = this.tickCounter - cell.autoSplitEligibleTick;
        if (ticksSinceEligible < autoDelay) return;

        if (client.cells.length >= this.config.playerMaxCells) {
            // Max cells reached => remove smallest cell to make room for autosplit
            var smallestCell = null;
            var smallestSize = Infinity;
            for (var j = 0; j < client.cells.length; j++) {
                var c = client.cells[j];
                if (c !== cell && c._size < smallestSize) {
                    smallestSize = c._size;
                    smallestCell = c;
                }
            }
            if (smallestCell) {
                this.removeNode(smallestCell);
                // Continue with autosplit below since we now have room
            } else {
                // No cell to remove (only this cell exists), just limit size
                cell.setSize(autoSize);
                return;
            }
        }

        // Calculate how many splits needed (OgarX formula)
        // This creates equal-sized pieces instead of halving
        var r = cell._size;
        var autoDiv = 1 / (autoSize * autoSize);
        var splitTimes = Math.ceil(r * r * autoDiv);
        var splitSizes = Math.min(Math.sqrt(r * r / splitTimes), autoSize);

        // Create splits with equal sizes
        for (var i = 1; i < splitTimes; i++) {
            if (client.cells.length >= this.config.playerMaxCells) break;

            // Calculate angle based on config
            var angle;
            if (this.config.playerAutoSplitAimed && client.mouse) {
                // Aimed mode: split towards mouse
                var dx = client.mouse.x - cell.position.x;
                var dy = client.mouse.y - cell.position.y;
                angle = Math.atan2(dx, dy);
            } else {
                // Random mode: original behavior
                angle = Math.random() * 2 * Math.PI;
            }

            this.splitPlayerCell(client, cell, angle, splitSizes * splitSizes / 100);
        }

        // Set original cell to equal split size
        cell.setSize(splitSizes);
        cell.autoSplitEligibleTick = -1; // Reset so it needs to exceed threshold again
        return;
    }

    // Original autosplit behavior (using playerMaxSize)
    // get size limit based off of rec mode
    if (!client.rec) var maxSize = this.config.playerMaxSize;
    else maxSize = 1e9; // increase limit for rec (1 bil)

    // Track when cell first exceeded autosplit size (for delay support)
    if (cell._size >= maxSize) {
        if (cell.autoSplitEligibleTick === undefined || cell.autoSplitEligibleTick === -1) {
            cell.autoSplitEligibleTick = this.tickCounter;
        }
    } else {
        cell.autoSplitEligibleTick = -1;
    }

    var autoDelay = this.config.playerAutoSplitDelay / 40;
    var ticksSinceEligible = cell.autoSplitEligibleTick !== -1 ? (this.tickCounter - cell.autoSplitEligibleTick) : 0;

    // check size limit
    if (client.mergeOverride || cell._size < maxSize || ticksSinceEligible < autoDelay) return;

    if (client.cells.length >= this.config.playerMaxCells || this.config.mobilePhysics) {
        if (this.config.mobilePhysics) {
            // Mobile physics: just limit size
            cell.setSize(maxSize);
        } else {
            // Max cells reached => remove smallest cell to make room for autosplit
            var smallestCell = null;
            var smallestSize = Infinity;
            for (var j = 0; j < client.cells.length; j++) {
                var c = client.cells[j];
                if (c !== cell && c._size < smallestSize) {
                    smallestSize = c._size;
                    smallestCell = c;
                }
            }
            if (smallestCell) {
                this.removeNode(smallestCell);
                // Continue with autosplit below
            } else {
                // No cell to remove (only this cell exists), just limit size
                cell.setSize(maxSize);
                return;
            }
        }
    }

    // If we haven't returned yet, proceed with autosplit
    if (!this.config.mobilePhysics) {
        // Calculate angle based on config
        var angle;
        if (this.config.playerAutoSplitAimed && client.mouse) {
            // Aimed mode: split towards mouse
            var dx = client.mouse.x - cell.position.x;
            var dy = client.mouse.y - cell.position.y;
            angle = Math.atan2(dx, dy);
        } else {
            // Random mode: original behavior
            angle = Math.random() * 2 * Math.PI;
        }
        this.splitPlayerCell(client, cell, angle, cell._mass / 2);
        cell.autoSplitEligibleTick = -1; // Reset so it needs to exceed threshold again
    }
};

GameServer.prototype.updateNodeQuad = function (node) {
    var item = node.quadItem;
    var x = node.position.x;
    var y = node.position.y;
    var size = node._size;
    // check for change
    if (item.x == x && item.y == y && item.size == size)
        return;
    // update quad tree
    item.x = x;
    item.y = y;
    item.size = size;
    item.bound.minx = x - size;
    item.bound.miny = y - size;
    item.bound.maxx = x + size;
    item.bound.maxy = y + size;
    this.finder.update(item);
};

// =====================================


// Checks cells for collision
GameServer.prototype.checkCellCollision = function (cell, check) {
    var dx = check.position.x - cell.position.x;
    var dy = check.position.y - cell.position.y;
    var d = Math.sqrt(dx * dx + dy * dy);

    // create collision manifold
    return {
        cell: cell,
        check: check,
        d: d,          // distance from cell to check
        dx: dx,    // normalized delta x from cell to check
        dy: dy,    // normalized delta y from cell to check
    };
};

// Checks if collision is rigid body collision
GameServer.prototype.checkRigidCollision = function (m) {
    if (!m.cell.owner || !m.check.owner)
        return false;
    if (m.cell.owner != m.check.owner) {
        // Different owners => same team
        return this.gameMode.haveTeams &&
            m.cell.owner.team == m.check.owner.team;
    }
    // Use config value for collision delay
    var noColliDelay = this.config.mobilePhysics ? 1 : this.config.playerCollisionDelay;
    if (m.cell.getAge() < noColliDelay || m.check.getAge() < noColliDelay) {
        return false; // just splited => ignore
    }
    return !m.cell._canRemerge || !m.check._canRemerge;
};

// Resolves rigid body collision (with mouse projection for linesplit)
GameServer.prototype.resolveRigidCollision = function (m) {
    // 1:1 from sort.js (plus our mouse projection hook).
    if (m.d == 0) return;

    var a = m.cell;
    var b = m.check;

    // Calculate push force
    var rsum = a._size + b._size; // radius sum of a & b
    var push = Math.min((rsum - m.d) / m.d, rsum - m.d); // min extrusion force
    if (push / rsum < 0) return;

    var massSum = a._sizeSquared + b._sizeSquared;
    if (massSum <= 0) return;

    // Default: mass-weighted (bigger moves less)
    var m1 = push * (b._sizeSquared / massSum); // apply to a
    var m2 = push * (a._sizeSquared / massSum); // apply to b

    var dx = m.dx;
    var dy = m.dy;

    // Mouse projection for linesplit (preserve old behavior)
    var projection = this._computeRigidProjection(a, b, dx, dy, m.d);
    if (projection && projection.applied) {
        dx = projection.dx;
        dy = projection.dy;
    }

    // COLLISION LOGGING: Capture positions BEFORE push
    var beforeAx = a.position.x;
    var beforeAy = a.position.y;
    var beforeBx = b.position.x;
    var beforeBy = b.position.y;

    a.position.x -= dx * m1;
    a.position.y -= dy * m1;
    b.position.x += dx * m2;
    b.position.y += dy * m2;

    // COLLISION LOGGING: Log rigid collision resolution (only when significant push > 0.1)
    var logOwner = a.owner || b.owner;
    if (push > 0.1 && logOwner && this._shouldLogCollision(logOwner.pID)) {
        var mouseX = logOwner.mouse ? logOwner.mouse.x : 0;
        var mouseY = logOwner.mouse ? logOwner.mouse.y : 0;
        var rsum = a._size + b._size;

        // Calculate how much each cell moved
        var deltaAx = a.position.x - beforeAx;
        var deltaAy = a.position.y - beforeAy;
        var deltaBx = b.position.x - beforeBx;
        var deltaBy = b.position.y - beforeBy;
        var distA = Math.sqrt(deltaAx * deltaAx + deltaAy * deltaAy);
        var distB = Math.sqrt(deltaBx * deltaBx + deltaBy * deltaBy);

        this._addCollisionLog(logOwner.pID, 'RIGID-COLLI', {
            cells: a.nodeId + ' vs ' + b.nodeId,
            ages: (a.getAge ? a.getAge() : '?') + ' vs ' + (b.getAge ? b.getAge() : '?'),
            sizes: a._size.toFixed(0) + '+' + b._size.toFixed(0) + '=' + rsum.toFixed(0),
            collision: 'dist=' + m.d.toFixed(0) + ' overlap=' + (rsum - m.d).toFixed(0) + ' push=' + push.toFixed(1),
            pushDir: '(' + dx.toFixed(2) + ',' + dy.toFixed(2) + ')',
            boostA: a.boostDistance ? a.boostDistance.toFixed(0) : '0',
            boostB: b.boostDistance ? b.boostDistance.toFixed(0) : '0',
            moveA: '(' + deltaAx.toFixed(0) + ',' + deltaAy.toFixed(0) + ') dist=' + distA.toFixed(0),
            moveB: '(' + deltaBx.toFixed(0) + ',' + deltaBy.toFixed(0) + ') dist=' + distB.toFixed(0),
            posA: '(' + beforeAx.toFixed(0) + ',' + beforeAy.toFixed(0) + ')→(' + a.position.x.toFixed(0) + ',' + a.position.y.toFixed(0) + ')',
            posB: '(' + beforeBx.toFixed(0) + ',' + beforeBy.toFixed(0) + ')→(' + b.position.x.toFixed(0) + ',' + b.position.y.toFixed(0) + ')',
            mouse: '(' + mouseX.toFixed(0) + ',' + mouseY.toFixed(0) + ')'
        });
    }
};

// Compute mouse projection for rigid collision (linesplit)
GameServer.prototype._computeRigidProjection = function (a, b, dx, dy, dist) {
    if (!a || !b) return null;
    if (!a.owner || !b.owner) return null;
    if (a.cellType !== 0 || b.cellType !== 0) return null;

    var owner = a.owner;
    if (owner !== b.owner) return null;
    if (!owner.useMouseProjectionCollision) return null;
    if (!owner.lockedMouse) return null;

    if (!a.rootCellId || !b.rootCellId || a.rootCellId !== b.rootCellId) return null;

    var mouseX = owner.lockedMouse.x;
    var mouseY = owner.lockedMouse.y;

    var midX = (a.position.x + b.position.x) / 2;
    var midY = (a.position.y + b.position.y) / 2;

    var dirX = mouseX - midX;
    var dirY = mouseY - midY;
    var distSq = dirX * dirX + dirY * dirY;
    if (distSq < 1.0) return { applied: false, dx: dx, dy: dy };

    var inv = 1 / Math.sqrt(distSq); // Standard sqrt for normalization
    var normX = dirX * inv;
    var normY = dirY * inv;

    var invDist = dist > 0 ? 1 / dist : 0;
    var dot = (dx * invDist) * normX + (dy * invDist) * normY;
    var sign = dot >= 0 ? 1 : -1;

    return {
        applied: true,
        dx: sign * normX * dist,
        dy: sign * normY * dist
    };
};

// =====================================
// CENTER OF MASS COLLISION SYSTEM
// Fixes that superposition jitter bullshit when cells stack up
// Uses Union-Find to group collisions and resolves from center outward
// =====================================

/**
 * Creates a Union-Find data structure for grouping collisions
 * This is O(n·α(n)) which is basically O(n) for mortals
 */
GameServer.prototype._createUnionFind = function () {
    var parent = new Map();
    var rank = new Map();

    return {
        find: function (x) {
            if (!parent.has(x)) {
                parent.set(x, x);
                rank.set(x, 0);
            }
            // Path compression - makes this shit fast as fuck
            if (parent.get(x) !== x) {
                parent.set(x, this.find(parent.get(x)));
            }
            return parent.get(x);
        },
        union: function (x, y) {
            var rootX = this.find(x);
            var rootY = this.find(y);
            if (rootX === rootY) return;

            // Union by rank - keeps the tree shallow
            var rankX = rank.get(rootX) || 0;
            var rankY = rank.get(rootY) || 0;
            if (rankX < rankY) {
                parent.set(rootX, rootY);
            } else if (rankX > rankY) {
                parent.set(rootY, rootX);
            } else {
                parent.set(rootY, rootX);
                rank.set(rootX, rankX + 1);
            }
        }
    };
};

/**
 * Groups collisions using Union-Find algorithm
 * Returns array of collision groups where cells share at least one partner
 */
GameServer.prototype._groupCollisions = function (collisions) {
    if (!collisions || collisions.length === 0) return [];

    var uf = this._createUnionFind();

    // Union all cells that collide with each other
    for (var i = 0; i < collisions.length; i++) {
        var cellId = collisions[i].cell.nodeId;
        var checkId = collisions[i].check.nodeId;
        uf.union(cellId, checkId);
    }

    // Group collisions by their root - cells in same group are connected
    var groupMap = new Map();
    for (var i = 0; i < collisions.length; i++) {
        var root = uf.find(collisions[i].cell.nodeId);
        if (!groupMap.has(root)) {
            groupMap.set(root, []);
        }
        groupMap.get(root).push(collisions[i]);
    }

    return Array.from(groupMap.values());
};

/**
 * Calculates the center of mass for a group of cells
 * Weighted by sizeSquared (area) because physics
 */
GameServer.prototype._calculateCenterOfMass = function (cells) {
    var totalMass = 0;
    var comX = 0;
    var comY = 0;

    for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        if (!cell || cell.isRemoved) continue;

        // Weight by sizeSquared (area) AND boostDistance (velocity/momentum)
        // Cells with higher boost act as "anchors" - pulling the COM towards them
        // This gives moving cells (splitting/ejected) right of way over static cells
        var boostFactor = 1 + (cell.boostDistance ? cell.boostDistance * 0.015 : 0);
        var mass = cell._sizeSquared * boostFactor;

        totalMass += mass;
        comX += cell.position.x * mass;
        comY += cell.position.y * mass;
    }

    if (totalMass <= 0) {
        return { x: 0, y: 0 };
    }

    return {
        x: comX / totalMass,
        y: comY / totalMass
    };
};

/**
 * Resolves rigid collision with damping factor
 * Damping prevents cells from yeeting into orbit
 */
GameServer.prototype._resolveRigidCollisionDamped = function (m, damping) {
    // Damped variant of sort.js rigid push (used by COM relaxation).
    if (m.d == 0) return;

    var a = m.cell;
    var b = m.check;

    var rsum = a._size + b._size;
    var damp = (damping != null ? damping : 1);
    var push = Math.min(((rsum - m.d) * damp) / m.d, (rsum - m.d) * damp);
    if (push / rsum < 0) return;

    var massSum = a._sizeSquared + b._sizeSquared;
    if (massSum <= 0) return;

    var m1 = push * (b._sizeSquared / massSum);
    var m2 = push * (a._sizeSquared / massSum);

    var dx = m.dx;
    var dy = m.dy;

    // Keep mouse projection for linesplit
    var projection = this._computeRigidProjection(a, b, dx, dy, m.d);
    if (projection && projection.applied) {
        dx = projection.dx;
        dy = projection.dy;
    }

    a.position.x -= dx * m1;
    a.position.y -= dy * m1;
    b.position.x += dx * m2;
    b.position.y += dy * m2;
};

/**
 * Resolves a group of rigid collisions using center-of-mass approach
 * Sorts by distance from COM (center outward) and iterates until stable
 * This is what fixes the jitter when cells stack up
 */
GameServer.prototype._resolveCenterOfMassRigidCollisions = function (collisionGroup) {
    if (!collisionGroup || collisionGroup.length === 0) return;

    // Collect all unique cells in this group
    var cellMap = new Map();
    for (var i = 0; i < collisionGroup.length; i++) {
        var collision = collisionGroup[i];
        if (!collision.cell.isRemoved) {
            cellMap.set(collision.cell.nodeId, collision.cell);
        }
        if (!collision.check.isRemoved) {
            cellMap.set(collision.check.nodeId, collision.check);
        }
    }

    var cells = Array.from(cellMap.values());
    if (cells.length < 2) {
        // Single cell? Just resolve normally, no fancy shit needed
        for (var i = 0; i < collisionGroup.length; i++) {
            if (!collisionGroup[i].cell.isRemoved && !collisionGroup[i].check.isRemoved) {
                this.resolveRigidCollision(collisionGroup[i].manifold);
            }
        }
        return;
    }

    // Calculate center of mass for the whole group
    var com = this._calculateCenterOfMass(cells);
    var self = this;

    // Helper to get distance from COM
    var getDist = function (cell) {
        var dx = cell.position.x - com.x;
        var dy = cell.position.y - com.y;
        return Math.sqrt(dx * dx + dy * dy);
    };

    // Sort by distance from center (ascending)
    // Process center collisions first, push outward - "Outward Resolution"
    collisionGroup.sort(function (a, b) {
        var distA = Math.min(getDist(a.cell), getDist(a.check));
        var distB = Math.min(getDist(b.cell), getDist(b.check));
        return distA - distB;
    });

    // DYNAMIC ITERATION: Check if any COLLISION in group would actually use mouse projection
    // This is more precise than checking player state - avoids false positives
    // Linelock/diagonal splits need 2 iterations for fast expansion
    // Normal splits use 1 iteration to preserve doublesplit mechanics
    var hasActiveProjection = false;
    for (var i = 0; i < collisionGroup.length; i++) {
        var col = collisionGroup[i];
        var a = col.cell;
        var b = col.check;

        // Check if this specific collision would use projection
        // Must have: same owner, linelock active, AND both cells have matching rootCellId
        if (a.owner && b.owner && a.owner === b.owner &&
            a.owner.useMouseProjectionCollision &&
            a.rootCellId && b.rootCellId &&
            a.rootCellId === b.rootCellId) {
            hasActiveProjection = true;
            break;
        }
    }

    var maxIterations = hasActiveProjection ? 2 : 1;
    var damping = 1; // Full force

    for (var iter = 0; iter < maxIterations; iter++) {
        var resolvedAny = false;

        for (var i = 0; i < collisionGroup.length; i++) {
            var collision = collisionGroup[i];
            if (collision.cell.isRemoved || collision.check.isRemoved) continue;

            // Re-calculate manifold with current positions (they moved since last check)
            var newManifold = this.checkCellCollision(collision.cell, collision.check);

            // Check if still colliding as rigid bodies
            if (this.checkRigidCollision(newManifold)) {
                this._resolveRigidCollisionDamped(newManifold, damping);
                resolvedAny = true;
            }
        }

        // If nothing resolved, we're stable - gtfo
        if (!resolvedAny) break;
    }
};

/**
 * Main entry point for center-of-mass rigid collision resolution
 * Groups collisions and resolves each group independently
 */
GameServer.prototype.resolveCenterOfMassRigidCollisions = function (collisions) {
    if (!collisions || collisions.length === 0) return;

    // Group collisions using Union-Find
    var groups = this._groupCollisions(collisions);

    // Resolve each group using iterative relaxation from COM
    for (var i = 0; i < groups.length; i++) {
        this._resolveCenterOfMassRigidCollisions(groups[i]);
    }
};

// =====================================
// BOOST TRANSFER SYSTEM
// Transfer boost from ejected mass to player when eating
// =====================================

/**
 * Apply boost transfer from source cell to target cell
 * Supports directional transfer (adds or subtracts based on direction alignment)
 */
GameServer.prototype._applyBoostTransfer = function (target, source, ratio, multiplier) {
    if (!target || !source) return;
    if (!(ratio > 0) || !(multiplier > 0)) return;
    if (!(source.boostDistance > 0)) return;

    var contribution = ratio * multiplier;
    if (!(contribution > 0)) return;

    var boostAmount = contribution * source.boostDistance;

    // Directional boost transfer: check if source and target are moving in same direction
    var directionMultiplier = 1; // Default: add boost

    if (target.boostDistance > 0 && target.boostDirection && source.boostDirection) {
        // Calculate dot product to determine direction alignment
        var dotProduct = (target.boostDirection.x * source.boostDirection.x) +
            (target.boostDirection.y * source.boostDirection.y);

        // If moving in opposite directions (dot < 0), subtract boost
        if (dotProduct < 0) {
            directionMultiplier = -1; // Slow down
        }
    }

    var finalBoostAmount = boostAmount * directionMultiplier;

    // Apply immediately
    target.boostDistance += finalBoostAmount;

    // Prevent negative boost distance
    if (target.boostDistance < 0) {
        target.boostDistance = 0;
    }
};

// Resolves non-rigid body collision
GameServer.prototype.resolveCollision = function (m) {
    var dp = this.detailedProfiler; // Profiler reference
    if (dp) dp.resolveCallCount++; // Count total calls

    var cell = m.cell;
    var check = m.check;
    if (cell._size > check._size) {
        cell = m.check;
        check = m.cell;
    }
    // Do not resolve removed
    if (cell.isRemoved || check.isRemoved)
        return;

    // Dead cells cannot eat anything, but CAN be eaten
    if (check.isDead)
        return;

    // =====================================
    // SPAWN PROTECTION CHECK
    // Newly spawned players cannot eat anything (but CAN be eaten)
    // EXCEPTION 1: Self-feed (own cells/ejected mass)
    // EXCEPTION 2: Same tag players can eat each other immediately
    // EXCEPTION 3: Dual and owner players can eat each other immediately
    // EXCEPTION 4: Viruses can always be eaten (they pop the player, not feed them)
    // =====================================
    if (check.owner && check.owner.spawnTick >= 0 && this.config.playerSpawnProtection > 0) {
        var ticksSinceSpawn = this.tickCounter - check.owner.spawnTick;
        if (ticksSinceSpawn < this.config.playerSpawnProtection) {
            var bypassSpawnProtection = false;

            // Check for self-feed (own cells/ejected mass)
            if (cell.owner && cell.owner === check.owner) {
                bypassSpawnProtection = true; // Merging own cells
            } else if (cell.cellType === 3 && cell.sourcePlayer && cell.sourcePlayer === check.owner) {
                bypassSpawnProtection = true; // Eating own ejected mass
            }

            // Determine victim owner (handles both PlayerCell and EjectedMass)
            var victimOwner = cell.owner;
            if (!victimOwner && cell.cellType === 3) victimOwner = cell.sourcePlayer;

            // EXCEPTION 2: Same tag players can bypass spawn protection
            // TERASPLIT MODE: When enabled, NO bypass for same-tag players
            if (!bypassSpawnProtection && !this.config.terasplitMode && victimOwner && check.owner &&
                typeof check.owner.getNormalizedTag === 'function' &&
                typeof victimOwner.getNormalizedTag === 'function') {
                var eaterTag = check.owner.getNormalizedTag();
                var victimTag = victimOwner.getNormalizedTag();
                if (eaterTag && victimTag && eaterTag === victimTag) {
                    bypassSpawnProtection = true;
                    check.owner.spawnTick = -1; // Disable spawn protection
                }
            }

            // EXCEPTION 3: Dual and owner players can bypass spawn protection
            // TERASPLIT MODE: When enabled, NO bypass for dual/owner players either
            if (!bypassSpawnProtection && !this.config.terasplitMode && victimOwner && check.owner) {
                var eaterIsDualOfVictim = check.owner.ownerPlayer && check.owner.ownerPlayer === victimOwner;
                var eaterIsOwnerOfVictim = check.owner.dualPlayer && check.owner.dualPlayer === victimOwner;
                var victimIsDualOfEater = victimOwner.ownerPlayer && victimOwner.ownerPlayer === check.owner;
                var victimIsOwnerOfEater = victimOwner.dualPlayer && victimOwner.dualPlayer === check.owner;

                if (eaterIsDualOfVictim || eaterIsOwnerOfVictim || victimIsDualOfEater || victimIsOwnerOfEater) {
                    bypassSpawnProtection = true;
                    check.owner.spawnTick = -1; // Disable spawn protection
                }
            }

            // EXCEPTION 4: Viruses can always be eaten (they pop the player, not feed them)
            if (!bypassSpawnProtection && cell.cellType === 2) {
                bypassSpawnProtection = true;
            }

            // Block eating if no bypass applies
            if (!bypassSpawnProtection) {
                if (dp) dp.eatFailSpawnProtect++;
                return; // Spawn protected - cannot eat
            }
        }
    }

    // check eating distance - playerEatOverlap controls how much overlap needed
    var eatOverlap = this.config.mobilePhysics ? 20 : this.config.playerEatOverlap;
    // Virus eating ejected mass needs more overlap (easier)
    eatOverlap = m.cell.cellType === 2 && m.check.cellType === 3 ? 20 : eatOverlap;
    if (m.d >= check._size - cell._size / eatOverlap) {
        if (dp) dp.eatFailDistance++;
        return; // too far => can't eat
    }

    // collision owned => ignore, resolve, or remerge
    // use collision delay for same-owner eat checks 
    if (cell.owner && cell.owner == check.owner) {
        var noColliDelay = this.config.mobilePhysics ? 1 : this.config.playerCollisionDelay;
        if (cell.getAge() < noColliDelay || check.getAge() < noColliDelay) {
            if (dp) dp.eatFailOwner++;
            return; // just splited => ignore
        }
        // _canRemerge kontrolü - remerge zamanı gelmemişse atla
        if (!cell._canRemerge || !check._canRemerge) {
            if (dp) dp.eatFailOwner++;
            return; // Not ready to remerge yet
        }
    } else if (check._size < cell._size * this.config.playerEatMult) {
        if (dp) dp.eatFailSize++;
        return; // Size mult insufficient
    } else if (!check.canEat(cell)) {
        if (dp) dp.eatFailCanEat++;
        return; // Cell refuses to be eaten
    }

    // =====================================
    // BOOST TRANSFER 
    // When player eats ejected mass, transfer some boost
    // =====================================
    if (this.config.boostTransferEnabled &&
        check.cellType === 0 && cell.cellType === 3 && cell.boostDistance > 0) {

        var normalMultiplier = this.config.playerBoostTransferMultiplier || 0;
        var reversedEnabled = this.config.playerBoostTransferReversed || 0;

        // Only proceed if at least one transfer type is enabled
        if ((normalMultiplier > 0 || reversedEnabled !== 0) &&
            cell._sizeSquared > 0 && check._sizeSquared > 0) {

            var applyNormalTransfer = false;
            var applyReversedTransfer = false;

            if (this.config.playerBoostTransferBoth) {
                // Both mode: apply both transfers simultaneously
                applyNormalTransfer = (normalMultiplier > 0);
                applyReversedTransfer = (reversedEnabled !== 0);
            } else {
                // Original mode: only one at a time
                if (reversedEnabled !== 0) {
                    applyReversedTransfer = true;
                } else if (normalMultiplier > 0) {
                    applyNormalTransfer = true;
                }
            }

            // yoinked from ogarx
            if (applyNormalTransfer) {
                var ogarXRatio = cell._size / (check._size + 100);
                if (ogarXRatio > 0 && isFinite(ogarXRatio)) {
                    this._applyBoostTransfer(check, cell, ogarXRatio, normalMultiplier, false);
                }
            }

            // --- Reversed transfer megasplit --
            if (applyReversedTransfer) {
                var shouldApplyReversed = false;

                if (check.owner && check.owner.cells && check.owner.cells.length > 0) {
                    // Find the largest cell
                    var largestCell = check.owner.cells[0];
                    for (var i = 1; i < check.owner.cells.length; i++) {
                        if (check.owner.cells[i]._size > largestCell._size) {
                            largestCell = check.owner.cells[i];
                        }
                    }

                    // Check if current cell is the largest
                    var isLargest = (check === largestCell);

                    // Check if the cell hasn't split recently (age >= 23 ticks)
                    var cellAge = check.getAge ? check.getAge() : 0;
                    var hasNotSplitRecently = cellAge >= 23;

                    shouldApplyReversed = isLargest && hasNotSplitRecently;
                }

                if (shouldApplyReversed) {
                    var reverseMultiplier = this.config.playerBoostTransferReverseMultiplier;
                    if (reverseMultiplier == null) reverseMultiplier = 0.00025;
                    if (reverseMultiplier > 0 && cell._size > 0 && check._size > 0) {
                        var reverseRatio = Math.sqrt(check._size / cell._size);
                        if (reverseRatio > 0 && isFinite(reverseRatio)) {
                            this._applyBoostTransfer(check, cell, reverseRatio, reverseMultiplier, false);
                        }
                    }
                }
            }
        }
    }

    // =====================================
    // SPLIT EAT PRIORITY RULE
    // If older cell eats during split overlap, transfer mass to YOUNGEST stacked cell
    // =====================================
    if (check.owner && check.owner.cells && check.owner.cells.length > 1) {
        // Check if cells are overlapping heavily - FIXED: use both sizes
        var overlapAmount = (check._size + cell._size) - m.d;
        var heavyOverlapThreshold = check._size / 3; // Heavy overlap = 1/3.6 of eater size

        if (overlapAmount >= heavyOverlapThreshold) {
            // Find the YOUNGEST cell from the same owner that's in overlap zone
            var youngestCell = null;
            var youngestAge = Infinity;
            var collisionDelay = this.config.mobilePhysics ? 1 : this.config.playerCollisionDelay;
            var hasYoungCells = false;

            for (var i = 0; i < check.owner.cells.length; i++) {
                var ownerCell = check.owner.cells[i];
                if (!ownerCell || ownerCell.isRemoved) continue;

                var cellAge = ownerCell.getAge ? ownerCell.getAge() : Infinity;

                // Check if this cell is young (recently split)
                if (cellAge < collisionDelay) {
                    hasYoungCells = true;
                }

                // Check if this cell is in the overlap zone (close to the EATING cell, not just prey)
                var dxOwner = ownerCell.position.x - check.position.x;
                var dyOwner = ownerCell.position.y - check.position.y;
                var distOwner = Math.sqrt(dxOwner * dxOwner + dyOwner * dyOwner);

                // Check overlap between sibling cells (are they stacked?)
                var siblingOverlap = (ownerCell._size + check._size) - distOwner;
                var heavyStackThreshold = (ownerCell._size + check._size) * 0.25; // Significant overlap (stacked)

                // Also check distance to prey to ensure it's not on the other side of the map
                var dxPrey = ownerCell.position.x - cell.position.x;
                var dyPrey = ownerCell.position.y - cell.position.y;
                var distPreySq = dxPrey * dxPrey + dyPrey * dyPrey;
                // Allow eating if within reasonable range of prey (radius + prey radius + buffer)
                var canReachPrey = distPreySq <= Math.pow(ownerCell._size + cell._size + 50, 2);

                // Find YOUNGEST stacked cell
                // Condition: Must be stacked with eater AND able to reach prey AND younger than current youngest
                if (siblingOverlap >= heavyStackThreshold && canReachPrey && cellAge < youngestAge) {
                    youngestAge = cellAge;
                    youngestCell = ownerCell;
                }
            }

            // If youngest cell is different from eater and there are young cells (split in progress)
            if (hasYoungCells && youngestCell && youngestCell !== check) {
                // COLLISION LOGGING: Log eat priority transfer
                if (check.owner && this._shouldLogCollision(check.owner.pID)) {
                    this._addCollisionLog(check.owner.pID, 'EAT-PRIORITY', {
                        transferred: true,
                        originalEater: check.nodeId,
                        originalEaterIdx: check.owner.cells.indexOf(check),
                        originalEaterSize: check._size.toFixed(0),
                        originalEaterAge: check.getAge ? check.getAge() : '?',
                        youngestCell: youngestCell.nodeId,
                        youngestCellIdx: check.owner.cells.indexOf(youngestCell),
                        youngestCellSize: youngestCell._size.toFixed(0),
                        youngestCellAge: youngestAge,
                        eaten: cell.nodeId,
                        eatenSize: cell._size.toFixed(0),
                        totalCells: check.owner.cells.length,
                        overlapAmt: overlapAmount.toFixed(1)
                    });
                }

                // Transfer the eat to the youngest cell instead
                cell.isRemoved = true;
                youngestCell.onEat(cell);
                cell.onEaten(youngestCell);
                cell.killedBy = youngestCell;

                // update bounds & Remove cell
                this.updateNodeQuad(youngestCell);
                this.removeNode(cell);
                return; // Exit early - youngest cell got the eat
            }
        }
    }

    // COLLISION LOGGING: Log eat event (normal path)
    var eatLogOwner = check.owner || cell.owner;
    if (eatLogOwner && this._shouldLogCollision(eatLogOwner.pID)) {
        this._addCollisionLog(eatLogOwner.pID, 'EAT', {
            eater: check.nodeId,
            eaterIdx: check.owner ? check.owner.cells.indexOf(check) : -1,
            eaterSize: check._size.toFixed(0),
            eaterType: check.cellType,
            eaten: cell.nodeId,
            eatenSize: cell._size.toFixed(0),
            eatenType: cell.cellType,
            distance: m.d.toFixed(1),
            overlap: (check._size - m.d).toFixed(1)
        });
    }

    // Consume effect (normal path)
    cell.isRemoved = true;
    check.onEat(cell);
    cell.onEaten(check);
    cell.killedBy = check;
    if (dp) dp.eatSuccess++; // Profiler: successful eat

    // update bounds & Remove cell
    this.updateNodeQuad(check);
    this.removeNode(cell);
};

GameServer.prototype.splitPlayerCell = function (client, parent, angle, mass) {
    var size = Math.sqrt(mass * 100);
    var size1 = Math.sqrt(parent._size * parent._size - size * size);

    // Too small to split
    if (isNaN(size1) || size < this.config.playerMinSize)
        return;

    // Remove size from parent cell
    parent.setSize(size1);

    // Get new position
    var pos = {
        x: parent.position.x,
        y: parent.position.y
    };

    // Create cell and add it to node list
    var newCell = new Entity.PlayerCell(this, client, pos, size);
    newCell.setBoost(this.config.splitVelocity, angle);

    // Inherit root cell ID from parent for mouse projection
    if (parent.rootCellId && parent.rootCellId !== 0) {
        newCell.rootCellId = parent.rootCellId;
    }

    this.addNode(newCell);

    // COLLISION LOGGING: Log new cell creation
    if (client && this._shouldLogCollision(client.pID)) {
        this._addCollisionLog(client.pID, 'SPLIT-CELL', {
            parentId: parent.nodeId,
            newCellId: newCell.nodeId,
            cellIndex: client.cells.indexOf(newCell),
            angle: (angle * 180 / Math.PI).toFixed(1) + '°',
            parentPos: { x: parent.position.x.toFixed(0), y: parent.position.y.toFixed(0) },
            newPos: { x: newCell.position.x.toFixed(0), y: newCell.position.y.toFixed(0) },
            boostDistance: newCell.boostDistance.toFixed(1)
        });
    }
};

GameServer.prototype.randomPos = function () {
    // Check if circular map is enabled
    if (this.config.worldIsCircular) {
        // Generate random position within circular boundary
        // Use rejection sampling for uniform distribution in circle
        var radius = this.config.worldRadius;
        var x, y, distSq;
        do {
            x = (Math.random() * 2 - 1) * radius;
            y = (Math.random() * 2 - 1) * radius;
            distSq = x * x + y * y;
        } while (distSq > radius * radius);

        return { x: x, y: y };
    } else {
        // Rectangular map (original behavior)
        return {
            x: this.border.minx + this.border.width * Math.random(),
            y: this.border.miny + this.border.height * Math.random()
        };
    }
};

// =====================================
// DEAD CELLS
// =====================================
GameServer.prototype.spawnDeadCellsFromPlayer = function (player) {
    if (!player || !player.cells || player.cells.length === 0) return;

    var deadCells = [];

    // Create dead cells from existing cells
    for (var i = 0; i < player.cells.length; i++) {
        var oldCell = player.cells[i];
        if (!oldCell) continue;

        // Create a new "corpse" cell with no owner
        var deadCell = new Entity.PlayerCell(this, null,
            { x: oldCell.position.x, y: oldCell.position.y },
            oldCell._size);

        // Gray color for dead cells
        deadCell.setColor({ r: 128, g: 128, b: 128 });

        // Preserve momentum if any
        deadCell.boostDistance = oldCell.boostDistance || 0;
        deadCell.boostDirection = {
            x: oldCell.boostDirection ? oldCell.boostDirection.x : 1,
            y: oldCell.boostDirection ? oldCell.boostDirection.y : 0
        };

        deadCell.isMoving = deadCell.boostDistance > 0;
        deadCell.isDead = true;
        deadCell.deadTick = this.tickCounter;
        deadCell.isCorpse = true;

        deadCells.push(deadCell);
    }

    // Remove all old cells from player
    while (player.cells.length > 0) {
        this.removeNode(player.cells[0]);
    }

    // Add dead cells to the game
    for (var j = 0; j < deadCells.length; j++) {
        var corpse = deadCells[j];
        this.addNode(corpse);

        // Add to moving nodes if it has momentum
        if (corpse.isMoving && this.movingNodes.indexOf(corpse) === -1) {
            // Track index for O(1) removal when collisionOptimization enabled
            if (this.config.collisionOptimization) {
                corpse._movingIndex = this.movingNodes.length;
            }
            this.movingNodes.push(corpse);
        }
    }

    Logger.debug('[DEAD] Spawned ' + deadCells.length + ' dead cells from player');
};

// Convert a single cell to a dead cell
GameServer.prototype.convertCellToDeadCell = function (cell) {
    if (!cell) return null;

    var Entity = require('./entity');

    // Create a new "corpse" cell with no owner
    var deadCell = new Entity.PlayerCell(this, null,
        { x: cell.position.x, y: cell.position.y },
        cell._size);

    // Gray color for dead cells - darker for border kills
    deadCell.setColor({ r: 100, g: 100, b: 100 });

    // Preserve momentum
    deadCell.boostDistance = cell.boostDistance || 0;
    deadCell.boostDirection = {
        x: cell.boostDirection ? cell.boostDirection.x : 1,
        y: cell.boostDirection ? cell.boostDirection.y : 0
    };

    deadCell.isMoving = deadCell.boostDistance > 0;
    deadCell.isDead = true;
    deadCell.deadTick = this.tickCounter;
    deadCell.isCorpse = true;
    deadCell.isBorderKill = true; // Mark as border kill

    // Remove the original cell from owner
    if (cell.owner) {
        var idx = cell.owner.cells.indexOf(cell);
        if (idx !== -1) {
            cell.owner.cells.splice(idx, 1);
        }
    }

    // Remove original cell from game
    this.removeNode(cell);

    // Add dead cell to game
    this.addNode(deadCell);

    // Add to moving nodes if it has momentum
    if (deadCell.isMoving && this.movingNodes.indexOf(deadCell) === -1) {
        // Track index for O(1) removal when collisionOptimization enabled
        if (this.config.collisionOptimization) {
            deadCell._movingIndex = this.movingNodes.length;
        }
        this.movingNodes.push(deadCell);
    }

    Logger.debug('[BORDER-KILL] Cell converted to dead cell at (' +
        Math.floor(deadCell.position.x) + ',' + Math.floor(deadCell.position.y) + ')');

    return deadCell;
};

GameServer.prototype.spawnFood = function () {
    var cell = new Entity.Food(this, null, this.randomPos(), this.config.foodMinSize),
        pos = this.randomPos();

    if (this.config.foodMassGrow) {
        var maxGrow = this.config.foodMaxSize - cell._size;
        cell.setSize(cell._size += maxGrow * Math.random());
    }
    cell.setColor(this.getRandomColor());
    this.addNode(cell);
}

GameServer.prototype.spawnVirus = function () {
    if (this.nodesVirus.length > this.config.virusMinAmount) return;
    var pos = this.randomPos(),
        attempts = 0,
        size = this.config.virusMinSize;

    while (this.willCollide(pos, size) && attempts <= 8) {
        // Do not spawn
        pos = this.randomPos();
        attempts++;
    }

    var v = new Entity.Virus(this, null, pos, size);
    this.addNode(v);
};

GameServer.prototype.spawnPlayer = function (player, pos, options) {
    if (this.disableSpawn) return; // Not allowed to spawn!

    var originalInputPos = pos ? { x: pos.x, y: pos.y } : null;

    Logger.info('\n[NEAR-SPAWN-GS-DEBUG] ================================================================================');
    Logger.info('[NEAR-SPAWN-GS-DEBUG] GameServer.spawnPlayer() CALLED');
    Logger.info('[NEAR-SPAWN-GS-DEBUG] Player: PID=' + player.pID + ' Name="' + player._name + '" Type=' + (player.playerType || 'MAIN'));
    Logger.info('[NEAR-SPAWN-GS-DEBUG] Input Position: ' + (originalInputPos ? '(' + Math.floor(originalInputPos.x) + ', ' + Math.floor(originalInputPos.y) + ')' : 'NULL'));
    Logger.info('[NEAR-SPAWN-GS-DEBUG] Options: ' + JSON.stringify({
        forceTournamentPosition: !!options?.forceTournamentPosition,
        lockSpawnPosition: !!options?.lockSpawnPosition,
        hasResolveCollision: !!(options?.resolveCollision),
        hasOnCollisionFail: !!(options?.onCollisionFail),
        maxCollisionRetries: options?.maxCollisionRetries || 'default'
    }));

    options = options || {};

    // Tournament mode spawn check - backup safety net
    // Primary check is in PlayerTracker.joinGame, but just in case something slips through
    if (this.tournamentData && this.tournamentData.enabled) {
        // Allow bots to spawn - they're our AI friends
        if (player.isBot) {
            // Bots are allowed in tournament mode
        } else if (!player.isMi && player.playerType !== 'DUAL_MINION') {
            if (!this.isAllowedToSpawn(player.discordId)) {
                // Silent block - joinGame already sent the message, no need to spam
                Logger.info('[NEAR-SPAWN-GS-DEBUG] ❌ BLOCKED by tournament spawn check');
                Logger.info('[NEAR-SPAWN-GS-DEBUG] ================================================================================\n');
                return;
            }
        }
    }

    // ========================================
    // TOURNAMENT SPAWN POSITIONING

    // ========================================
    var tournamentOverridePos = null;
    if (this.tournamentManager && this.tournamentManager.isActive) {
        // Pass player object so getSpawnPosition can detect duals
        var tournamentPos = this.tournamentManager.getSpawnPosition(player.discordId, player);
        if (tournamentPos) {
            tournamentOverridePos = { x: tournamentPos.x, y: tournamentPos.y };
            pos = tournamentPos;
            var playerName = player.discordName || player._name || 'Player';
            var isDual = player.playerType === 'DUAL_MINION';
            Logger.info('[NEAR-SPAWN-GS-DEBUG] ⚡ TOURNAMENT OVERRIDE: ' + (isDual ? 'DUAL of ' : '') + playerName +
                ' → (' + Math.round(pos.x) + ', ' + Math.round(pos.y) + ')');

            // FORCE exact tournament position - no collision checks, no fallback
            options.forceTournamentPosition = true;
        } else {
            Logger.info('[NEAR-SPAWN-GS-DEBUG] Tournament returned NULL - using normal spawn logic');
        }

        // Start frozen if tournament hasn't started yet
        // This includes bots - they should be frozen until round starts
        if (this.tournamentManager.isFrozen) {
            player.frozen = true;
        }
    }

    // Check for special start size(s)
    var size = this.config.playerStartSize;
    if (player.spawnmass && !player.isMi) {
        size = player.spawnmass;
    } else if (player.isMi) {
        size = this.config.minionStartSize,
            maxStart = this.config.minionMaxStartSize;
        if (maxStart > size)
            size = Math.random() * (maxStart - size) + size;
    }

    // TOURNAMENT MODE: Use playerAfterDeathSize for respawns after death
    var tm = this.tournamentManager;
    if (tm && tm.isActive && !tm.isFrozen && tm.roundStarted &&
        !player.isBot && !player.isMi &&
        player.lastSpawnName && // Has spawned before = this is a respawn
        this.config.playerAfterDeathSize && this.config.playerAfterDeathSize > 0) {
        size = this.config.playerAfterDeathSize;
        Logger.info('[NEAR-SPAWN-GS-DEBUG] Using tournament after-death size: ' + size);
    }

    // BOTS: Use configured bot size if available
    if (player.isBot) {
        var botSize = this.config.tournamentBotStartSize;
        if (botSize && botSize > 0) {
            size = botSize;
            Logger.info('[NEAR-SPAWN-GS-DEBUG] Bot using tournamentBotStartSize: ' + size);
        }
    }

    Logger.info('[NEAR-SPAWN-GS-DEBUG] Spawn size: ' + Math.floor(size));

    // Check if can spawn from ejected mass
    // IMPORTANT: Skip ejected mass spawn if we have a locked/forced position
    // This preserves the carefully calculated near-partner or near-death spawn position
    var useEjectSpawn = !options.lockSpawnPosition && !options.forceNearSpawn && !options.forceTournamentPosition;

    if (useEjectSpawn) {
        var index = (this.nodesEjected.length - 1) * ~~Math.random();
        var eject = this.nodesEjected[index]; // Randomly selected
        if (eject && !eject.isRemoved && eject.boostDistance < 1 &&
            Math.random() <= this.config.ejectSpawnPercent) {
            // Spawn from ejected mass
            pos = {
                x: eject.position.x,
                y: eject.position.y
            };
            player.setColor(eject.color);
            Logger.info('[NEAR-SPAWN-GS-DEBUG] Spawning from ejected mass at (' + Math.floor(pos.x) + ', ' + Math.floor(pos.y) + ')');
        }
    } else {
        Logger.info('[NEAR-SPAWN-GS-DEBUG] Skipping ejected mass spawn (locked/forced position)');
    }

    // Tournament mode: skip ALL collision checks - spawn exactly where we say
    var forceTournament = !!options.forceTournamentPosition;

    Logger.info('[NEAR-SPAWN-GS-DEBUG] COLLISION RESOLUTION:');
    Logger.info('[NEAR-SPAWN-GS-DEBUG]   - forceTournamentPosition: ' + forceTournament);

    // Only do collision resolution if NOT tournament forced position
    if (!forceTournament) {
        var lockPreferred = !!options.lockSpawnPosition;
        var maxCollisionRetries = Math.max(1, options.maxCollisionRetries || (lockPreferred ? 25 : 10));
        var attempt = 0;
        var posBeforeCollision = { x: pos.x, y: pos.y };

        Logger.info('[NEAR-SPAWN-GS-DEBUG]   - lockSpawnPosition: ' + lockPreferred);
        Logger.info('[NEAR-SPAWN-GS-DEBUG]   - maxCollisionRetries: ' + maxCollisionRetries);
        Logger.info('[NEAR-SPAWN-GS-DEBUG]   - Initial willCollide check: ' + this.willCollide(pos, size));

        var self = this;
        var tryResolvePreferred = function (meta) {
            if (!options.resolveCollision || typeof options.resolveCollision !== 'function') {
                return false;
            }
            var replacement = null;
            try {
                replacement = options.resolveCollision({
                    attempt: meta.attempt,
                    player: player,
                    size: size,
                    lastPosition: pos
                });
            } catch (err) {
                Logger.warn('[NEAR-SPAWN-GS-DEBUG] resolveCollision error: ' + err.message);
            }
            if (replacement && typeof replacement.x === 'number' && typeof replacement.y === 'number') {
                Logger.info('[NEAR-SPAWN-GS-DEBUG]   → resolveCollision attempt ' + meta.attempt + ': (' + Math.floor(replacement.x) + ', ' + Math.floor(replacement.y) + ')');
                pos = replacement;
                return true;
            }
            return false;
        };

        while (attempt < maxCollisionRetries && this.willCollide(pos, size)) {
            attempt++;
            if (lockPreferred && tryResolvePreferred({ attempt: attempt })) {
                continue;
            }
            if (lockPreferred) {
                break;
            }
            var oldPos = { x: pos.x, y: pos.y };
            pos = this.randomPos();
            Logger.info('[NEAR-SPAWN-GS-DEBUG]   → Collision attempt ' + attempt + ': (' + Math.floor(oldPos.x) + ', ' + Math.floor(oldPos.y) + ') → RANDOM (' + Math.floor(pos.x) + ', ' + Math.floor(pos.y) + ')');
        }

        if (this.willCollide(pos, size) && lockPreferred) {
            var handled = false;
            var forceSpawn = !!options.forceNearSpawn; // NEW: Check if we should force spawn here

            if (typeof options.onCollisionFail === 'function') {
                var failPos = options.onCollisionFail({
                    attempts: attempt,
                    player: player,
                    size: size,
                    lastPosition: pos
                });
                if (failPos && typeof failPos.x === 'number' && typeof failPos.y === 'number') {
                    Logger.info('[NEAR-SPAWN-GS-DEBUG]   → onCollisionFail returned: (' + Math.floor(failPos.x) + ', ' + Math.floor(failPos.y) + ')');
                    pos = failPos;
                    handled = true;

                    // NEW: If forceNearSpawn is enabled, we FORCE spawn at this position
                    // even if it still collides - game physics will push cells apart
                    if (forceSpawn) {
                        Logger.info('[NEAR-SPAWN-GS-DEBUG]    FORCE SPAWN enabled - spawning despite collision');
                        lockPreferred = true; // Keep lockPreferred true to skip random fallback
                    }
                }
            }
            if (!handled) {
                Logger.warn('[NEAR-SPAWN-GS-DEBUG]  Could not find safe preferred spawn after ' + attempt + ' retries!');
                if (forceSpawn) {
                    // Even without a failPos, keep the current position if forceNearSpawn
                    Logger.info('[NEAR-SPAWN-GS-DEBUG]    FORCE SPAWN enabled - keeping current position despite collision');
                } else {
                    Logger.warn('[NEAR-SPAWN-GS-DEBUG]   Falling back to random spawn');
                    lockPreferred = false;
                }
            }
        }

        // Only use random fallback if lockPreferred was explicitly disabled (not forceNearSpawn)
        if (!lockPreferred && !options.forceNearSpawn) {
            for (var i = 0; i < maxCollisionRetries && this.willCollide(pos, size); i++) {
                pos = this.randomPos();
                Logger.info('[NEAR-SPAWN-GS-DEBUG]   → Random fallback ' + i + ': (' + Math.floor(pos.x) + ', ' + Math.floor(pos.y) + ')');
            }
        } else if (!lockPreferred && options.forceNearSpawn) {
            Logger.info('[NEAR-SPAWN-GS-DEBUG]    Skipping random fallback due to forceNearSpawn flag');
        }

        var distFromPreferred = Math.sqrt(
            Math.pow(pos.x - posBeforeCollision.x, 2) +
            Math.pow(pos.y - posBeforeCollision.y, 2)
        );
        if (distFromPreferred > 500) {
            Logger.warn('[NEAR-SPAWN-GS-DEBUG]  Final position is ' + Math.floor(distFromPreferred) + ' away from preferred!');
        }
    } else {
        Logger.info('[NEAR-SPAWN-GS-DEBUG]   - Skipping collision checks (tournament forced)');
    }

    // FINAL POSITION CHECK
    Logger.info('[NEAR-SPAWN-GS-DEBUG] FINAL SPAWN:');
    Logger.info('[NEAR-SPAWN-GS-DEBUG]   - Final Position: (' + Math.floor(pos.x) + ', ' + Math.floor(pos.y) + ')');
    if (originalInputPos) {
        var distFromInput = Math.sqrt(
            Math.pow(pos.x - originalInputPos.x, 2) +
            Math.pow(pos.y - originalInputPos.y, 2)
        );
        Logger.info('[NEAR-SPAWN-GS-DEBUG]   - Distance from input: ' + Math.floor(distFromInput));
        if (distFromInput > 1000) {
            Logger.warn('[NEAR-SPAWN-GS-DEBUG]  SPAWN FAR FROM INPUT! Distance=' + Math.floor(distFromInput));
        }
    }

    // Check against death position
    if (player.lastDeathPosition) {
        var distFromDeath = Math.sqrt(
            Math.pow(pos.x - player.lastDeathPosition.x, 2) +
            Math.pow(pos.y - player.lastDeathPosition.y, 2)
        );
        Logger.info('[NEAR-SPAWN-GS-DEBUG]   - Distance from death pos: ' + Math.floor(distFromDeath));
        if (distFromDeath > 1500) {
            Logger.warn('[NEAR-SPAWN-GS-DEBUG] ⚠️⚠️ SPAWN FAR FROM DEATH POSITION! Distance=' + Math.floor(distFromDeath));
        }
    }

    // Spawn player and add to world
    var cell = new Entity.PlayerCell(this, player, pos, size);
    cell.isSpawned = true; // Mark as spawned (not split) for eject delay logic
    this.addNode(cell);

    // Reset spectate state on spawn - you're playing now, not watching!
    player.spawnTick = this.tickCounter;
    player.spectate = false;
    player.freeRoam = false;
    player.spectateTargetPid = null;

    // Set initial mouse coords
    player.mouse = {
        x: pos.x,
        y: pos.y
    };

    Logger.info('[NEAR-SPAWN-GS-DEBUG] ✅ Cell created: NodeID=' + cell.nodeId + ' at (' + Math.floor(cell.position.x) + ', ' + Math.floor(cell.position.y) + ')');
    Logger.info('[NEAR-SPAWN-GS-DEBUG] ================================================================================\n');

    // Remove external minions if necessary (but NOT DUAL_MINION players!)
    // DUAL_MINION is a special case - it's marked as minion but should be allowed to spawn
    if (player.isMinion && player.playerType !== 'DUAL_MINION') {
        player.socket.close(1000, "Marked as minion");
        this.removeNode(cell);
    }
};

GameServer.prototype.willCollide = function (pos, size) {
    // Look if there will be any collision with the current nodes
    var bound = {
        minx: pos.x - size,
        miny: pos.y - size,
        maxx: pos.x + size,
        maxy: pos.y + size
    };
    var sq = bound.minx * bound.minx + bound.miny * bound.miny;
    if (sq + (size * size) <= size * 2) {
        return null; // not safe => try again
    }
    return this.finder.any(
        bound, function (item) {
            return item.cell.cellType != 3; // don't check ejected
        });
};

GameServer.prototype.splitCells = function (client) {
    // Update lastSplitTime for anti-camp decay (source-cpp style)
    client.lastSplitTime = Date.now();
    client.lastSplitTick = this.tickCounter; // Track split tick for eject hiding

    // Split cell order decided by cell age
    var cellToSplit = [];
    for (var i = 0; i < client.cells.length; i++) {
        if (client.cells[i]._size < this.config.playerMinSplitSize)
            continue; // cannot split
        cellToSplit.push(client.cells[i]);
    }

    // Check if reverse split ordering should be applied
    var shouldReverseSplitOrder = false;
    if (this.config.playerSplitReverseMass > 0 && client.isFeedingThisTick) {
        // Calculate total player mass
        var totalMass = 0;
        for (var i = 0; i < client.cells.length; i++) {
            if (client.cells[i]) {
                totalMass += client.cells[i]._mass;
            }
        }

        // Enable reverse ordering if mass >= threshold and feeding this tick
        // Enable reverse ordering based on specific cell counts (16, 32, 64, 128, 100)
        var cellCount = client.cells.length;
        if (totalMass >= this.config.playerSplitReverseMass &&
            (cellCount === 16 || cellCount === 32 || cellCount === 64 || cellCount === 128 || cellCount === 100)) {
            shouldReverseSplitOrder = true;
        }
    }

    if (shouldReverseSplitOrder) {
        cellToSplit.sort(function (a, b) {
            var massDiff = b._mass - a._mass;
            if (massDiff !== 0) return massDiff;
            return a.birthTick - b.birthTick;
        });
    } else {
        // Normal order: oldest cells split first (lower birthTick = older)
        cellToSplit.sort(function (a, b) {
            return a.birthTick - b.birthTick;
        });
    }

    // Get maximum cells for rec mode
    var maxCells;
    if (!client.rec) maxCells = this.config.playerMaxCells;
    else maxCells = Math.max(this.config.playerMaxCells, 200); // increase limit for rec (200 cells)

    // COLLISION LOGGING: Log split action
    if (this._shouldLogCollision(client.pID)) {
        this._addCollisionLog(client.pID, 'SPLIT', {
            cellCount: client.cells.length,
            splittableCells: cellToSplit.length,
            maxCells: maxCells,
            reverseSplit: shouldReverseSplitOrder,
            mouseX: client.mouse.x.toFixed(1),
            mouseY: client.mouse.y.toFixed(1)
        });
    }

    // Split split-able cells
    for (var i = 0; i < cellToSplit.length; i++) {
        var cell = cellToSplit[i];
        // Engine-style mouse direction normalization with minimum distance
        var x = client.mouse.x - cell.position.x;
        var y = client.mouse.y - cell.position.y;
        var d = Math.sqrt(x * x + y * y);
        if (d < 1) {
            x = 1;
            y = 0;
        } else {
            x /= d;
            y /= d;
        }

        if (client.cells.length >= maxCells) return;

        // Now split player cells
        var angle = Math.atan2(x, y);
        this.splitPlayerCell(client, cell, angle, cell._mass * .5);
    }
};

GameServer.prototype.canEjectMass = function (client) {
    if (client.lastEject === null) {
        // first eject
        client.lastEject = this.tickCounter;
        return true;
    }
    var dt = this.tickCounter - client.lastEject;
    if (dt < this.config.ejectCooldown) {
        // reject (cooldown)
        return false;
    }
    client.lastEject = this.tickCounter;
    return true;
};

GameServer.prototype.ejectMass = function (client) {
    if (!this.canEjectMass(client) || client.frozen)
        return;
    for (var i = 0; i < client.cells.length; i++) {
        var cell = client.cells[i];

        if (cell._size < this.config.playerMinEjectSize)
            continue; // Too small to eject

        // Check if cell is too young to eject (just split)
        // This prevents instant W after splitting
        if (cell.getAge() < this.config.playerNoEjectDelay)
            continue; // Cell too young to eject

        var dx = client.mouse.x - cell.position.x;
        var dy = client.mouse.y - cell.position.y;
        var sq = Math.sqrt(dx * dx + dy * dy);
        if (sq > 1) {
            dx /= sq;
            dy /= sq;
        } else {
            dx = 1;
            dy = 0;
        }

        // Remove mass from parent cell first
        var loss = this.config.ejectSizeLoss;
        var squared = cell._sizeSquared - loss * loss;
        cell.setSize(Math.sqrt(squared));

        // Get starting position
        var pos = {
            x: cell.position.x + dx * cell._size,
            y: cell.position.y + dy * cell._size
        };

        // Randomize angle
        var angle = Math.atan2(dx, dy);
        angle += (Math.random() * 0.6) - 0.3;

        // Create cell and add it to node list
        if (!this.config.ejectVirus) {
            var ejected = new Entity.EjectedMass(this, null, pos, this.config.ejectSize);
            ejected.sourcePlayer = client; // Track who ejected this
        } else {
            ejected = new Entity.Virus(this, null, pos, this.config.ejectSize);
        }
        ejected.setColor(cell.color);
        ejected.setBoost(this.config.ejectVelocity, angle);

        // Track parent cell age for eject hiding (young cells = hide ejects)
        if (cell.isSpawned) {
            // If spawned cell, treat as "old" to bypass hide delay
            ejected.parentCellAge = Number.MAX_SAFE_INTEGER;
        } else {
            ejected.parentCellAge = cell.getAge();
        }

        this.addNode(ejected);
    }
};

GameServer.prototype.shootVirus = function (parent, angle) {
    var pos = {
        x: parent.position.x,
        y: parent.position.y,
    };

    // Create virus and add it to node list
    var newVirus = new Entity.Virus(this, null, pos, this.config.virusMinSize);
    newVirus.setBoost(this.config.virusVelocity, angle);
    this.addNode(newVirus);
};

GameServer.prototype.loadConfig = function () {
    // Check if config file is specified as command line argument
    // This is how PM2 ecosystem passes different configs for each gamemode
    var fileNameConfig = null;
    for (var i = 2; i < process.argv.length; i++) {
        var arg = process.argv[i];
        // Skip flags like --noconsole, --help
        if (arg === '--noconsole' || arg === '--help') continue;
        // First non-flag argument is the config file
        if (!arg.startsWith('--')) {
            fileNameConfig = arg;
            break;
        }
    }

    // Default to gameserver.ini if no config specified
    if (!fileNameConfig) {
        fileNameConfig = this.srcFiles + '/gameserver.ini';
    }

    // Resolve to absolute path if relative (PM2 sometimes fucks up cwd)
    var path = require('path');
    if (!path.isAbsolute(fileNameConfig)) {
        fileNameConfig = path.resolve(process.cwd(), fileNameConfig);
    }

    Logger.info("Loading config: " + fileNameConfig);

    var ini = require(this.srcFiles + '/modules/ini.js');
    try {
        if (!fs.existsSync(fileNameConfig)) {
            // No config - only generate default if using default path
            if (fileNameConfig === this.srcFiles + '/gameserver.ini') {
                Logger.warn("Config not found... Generating new config");
                fs.writeFileSync(fileNameConfig, ini.stringify(this.config), 'utf-8');
            } else {
                Logger.error("Config file not found: " + fileNameConfig);
                Logger.error("Make sure the config file exists!");
                return;
            }
        } else {
            // Load the contents of the config file
            var load = ini.parse(fs.readFileSync(fileNameConfig, 'utf-8'));
            // Replace all the default config's values with the loaded config's values
            for (var key in load) {
                if (this.config.hasOwnProperty(key)) this.config[key] = load[key];
                else Logger.error("Unknown config value: " + key);
            }
            Logger.info("Config loaded successfully from: " + fileNameConfig);
        }
    } catch (err) {
        Logger.error(err.stack);
        Logger.error("Failed to load " + fileNameConfig + ": " + err.message);
    }
    Logger.setVerbosity(this.config.logVerbosity);
    Logger.setFileVerbosity(this.config.logFileVerbosity);

    // DEBUG: Log tournament config values after loading
    Logger.info('[CONFIG-DEBUG] tournamentMode = ' + this.config.tournamentMode);
    Logger.info('[CONFIG-DEBUG] tournamentPlayersFile = ' + (this.config.tournamentPlayersFile || 'EMPTY/NULL'));
    Logger.info('[CONFIG-DEBUG] tournamentBotStartSize = ' + this.config.tournamentBotStartSize);
    Logger.info('[CONFIG-DEBUG] playerAfterDeathSize = ' + this.config.playerAfterDeathSize);
    Logger.info('[CONFIG-DEBUG] playerStartSize = ' + this.config.playerStartSize);
};

GameServer.prototype.loadBadWords = function () {
    var fileNameBadWords = this.srcFiles + '/badwords.txt';
    try {
        if (!fs.existsSync(fileNameBadWords)) {
            Logger.warn(fileNameBadWords + " not found");
        } else {
            var words = fs.readFileSync(fileNameBadWords, 'utf-8');
            words = words.split(/[\r\n]+/);
            words = words.map(function (arg) { return arg.trim().toLowerCase(); });
            words = words.filter(function (arg) { return !!arg; });
            this.badWords = words;
            Logger.info(this.badWords.length + " bad words loaded");
        }
    } catch (err) {
        Logger.error(err.stack);
        Logger.error("Failed to load " + fileNameBadWords + ": " + err.message);
    }
};

// Tournament mode - load allowed Discord IDs for spawn restriction
GameServer.prototype.loadTournamentPlayers = function () {
    // Initialize tournament data
    this.tournamentData = {
        enabled: false,
        allowedDiscordIds: [],
        teamNames: {}
    };

    // Check if tournament mode is enabled
    if (!this.config.tournamentMode) {
        return;
    }

    var playersFile = this.config.tournamentPlayersFile;
    Logger.info('[TOURNAMENT] Config tournamentMode: ' + this.config.tournamentMode);
    Logger.info('[TOURNAMENT] Config tournamentPlayersFile: ' + (playersFile || 'EMPTY'));

    if (!playersFile) {
        Logger.warn('[TOURNAMENT] Tournament mode enabled but no players file specified!');
        return;
    }

    try {
        if (!fs.existsSync(playersFile)) {
            Logger.error('[TOURNAMENT] Players file not found: ' + playersFile);
            return;
        }

        var data = JSON.parse(fs.readFileSync(playersFile, 'utf-8'));

        this.tournamentData = {
            enabled: true,
            tournamentId: data.tournamentId || 'Unknown',
            matchId: data.matchId || 'Unknown',
            allowedDiscordIds: data.allowedDiscordIds || [],
            teamNames: data.teamNames || {},
            team1Players: data.team1Players || [],
            team2Players: data.team2Players || []
        };

        Logger.info('[TOURNAMENT] ========================================');
        Logger.info('[TOURNAMENT] Tournament Mode ENABLED');
        Logger.info('[TOURNAMENT] Match: ' + this.tournamentData.tournamentId + ' #' + this.tournamentData.matchId);
        Logger.info('[TOURNAMENT] Teams: ' + (this.tournamentData.teamNames.team1 || '?') + ' vs ' + (this.tournamentData.teamNames.team2 || '?'));
        Logger.info('[TOURNAMENT] Team 1 Players: ' + this.tournamentData.team1Players.length);
        Logger.info('[TOURNAMENT] Team 2 Players: ' + this.tournamentData.team2Players.length);
        Logger.info('[TOURNAMENT] Total Allowed: ' + this.tournamentData.allowedDiscordIds.length);
        Logger.info('[TOURNAMENT] ========================================');

    } catch (err) {
        Logger.error('[TOURNAMENT] Failed to load players file: ' + err.message);
        Logger.error(err.stack);
    }
};

// Check if a Discord ID is allowed to spawn in tournament mode
GameServer.prototype.isAllowedToSpawn = function (discordId) {
    // If tournament mode is not enabled, everyone can spawn
    if (!this.tournamentData || !this.tournamentData.enabled) {
        return true;
    }

    // If no Discord ID provided, deny spawn
    if (!discordId) {
        Logger.debug('[TOURNAMENT] Spawn denied - no Discord ID');
        return false;
    }

    // Check if Discord ID is in the allowed list
    var isAllowed = this.tournamentData.allowedDiscordIds.includes(discordId);

    if (!isAllowed) {
        Logger.info('[TOURNAMENT] Spawn denied for Discord ID: ' + discordId);
    }

    return isAllowed;
};

// Initialize tournament manager with team data from the players file
GameServer.prototype._initTournamentManagerData = function () {
    if (!this.tournamentManager) return;
    if (!this.tournamentData || !this.tournamentData.enabled) return;

    // Parse team data from the players file
    // The players file contains: allowedDiscordIds, teamNames, team1Players, team2Players
    var data = this.tournamentData;

    // Initialize tournament even with minimal data
    var config = {
        team1Name: (data.teamNames && data.teamNames.team1) || 'Team 1',
        team2Name: (data.teamNames && data.teamNames.team2) || 'Team 2',
        team1Players: data.team1Players || [],
        team2Players: data.team2Players || [],
        duration: 8 // Default 8 minutes
    };

    // If we don't have separate team arrays, try to split allowedDiscordIds
    if (config.team1Players.length === 0 && config.team2Players.length === 0 && data.allowedDiscordIds) {
        // For legacy format, just put all players in one array - referee can organize later
        config.team1Players = data.allowedDiscordIds.slice(0, Math.ceil(data.allowedDiscordIds.length / 2));
        config.team2Players = data.allowedDiscordIds.slice(Math.ceil(data.allowedDiscordIds.length / 2));
        Logger.warn('[TOURNAMENT] Auto-split players between teams (legacy format)');
    }

    this.tournamentManager.initTournament(config);
    Logger.info('[TOURNAMENT]  TournamentManager initialized!');
    Logger.info('[TOURNAMENT] Team 1: ' + config.team1Name + ' (' + config.team1Players.length + ' players)');
    Logger.info('[TOURNAMENT] Team 2: ' + config.team2Name + ' (' + config.team2Players.length + ' players)');
};

GameServer.prototype.loadUserList = function () {
    var UserRoleEnum = require(this.srcFiles + '/enum/UserRoleEnum');
    var fileNameUsers = this.srcFiles + '/enum/userRoles.json';
    try {
        this.userList = [];
        if (!fs.existsSync(fileNameUsers)) {
            Logger.warn(fileNameUsers + " is missing.");
            return;
        }
        var usersJson = fs.readFileSync(fileNameUsers, 'utf-8');
        var list = JSON.parse(usersJson.trim());
        for (var i = 0; i < list.length;) {
            var item = list[i];
            if (!item.hasOwnProperty("ip") ||
                !item.hasOwnProperty("password") ||
                !item.hasOwnProperty("role") ||
                !item.hasOwnProperty("name")) {
                list.splice(i, 1);
                continue;
            }
            if (!item.password || !item.password.trim()) {
                Logger.warn("User account \"" + item.name + "\" disabled");
                list.splice(i, 1);
                continue;
            }
            if (item.ip) item.ip = item.ip.trim();
            item.password = item.password.trim();
            if (!UserRoleEnum.hasOwnProperty(item.role)) {
                Logger.warn("Unknown user role: " + item.role);
                item.role = UserRoleEnum.USER;
            } else {
                item.role = UserRoleEnum[item.role];
            }
            item.name = (item.name || "").trim();
            i++;
        }
        this.userList = list;
        Logger.info(this.userList.length + " user records loaded.");
    } catch (err) {
        Logger.error(err.stack);
        Logger.error("Failed to load " + fileNameUsers + ": " + err.message);
    }
};

GameServer.prototype.loadIpBanList = function () {
    var fileNameIpBan = this.srcFiles + '/ipbanlist.txt';
    try {
        if (fs.existsSync(fileNameIpBan)) {
            // Load and input the contents of the ipbanlist file
            this.ipBanList = fs.readFileSync(fileNameIpBan, "utf8").split(/[\r\n]+/).filter(function (x) {
                return x != ''; // filter empty lines
            });
            Logger.info(this.ipBanList.length + " IP ban records loaded.");
        } else {
            Logger.warn(fileNameIpBan + " is missing.");
        }
    } catch (err) {
        Logger.error(err.stack);
        Logger.error("Failed to load " + fileNameIpBan + ": " + err.message);
    }
};

// Custom prototype function
WebSocket.prototype.sendPacket = function (packet) {
    if (packet === null) return;
    if (this.readyState == WebSocket.OPEN) {
        if (this._socket.writable != null && !this._socket.writable)
            return;

        var buffer = packet.build(this.playerTracker.socket.packetHandler.protocol);
        if (buffer != null) {
            this.send(buffer, { binary: true });
            this.playerTracker.gameServer.uploadUsage += 448 + buffer.length * 8;

            // Bandwidth profiling
            var dp = this.playerTracker.gameServer.detailedProfiler;
            if (dp) {
                dp.bytesSent += buffer.length;
                dp.packetsSent++;
            }
        }
    } else {
        this.readyState = WebSocket.CLOSED;
        this.emit('close');
    }
};

GameServer.prototype.startStatsServer = function (port) {
    // Create stats
    this.stats = "Test";
    this.getStats();

    // Show stats
    this.httpServer = http.createServer(function (req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200);
        res.end(this.stats);
    }.bind(this));
    this.httpServer.on('error', function (err) {
        Logger.error("Stats Server: " + err.message);
    });

    var getStatsBind = this.getStats.bind(this);
    this.httpServer.listen(port, function () {
        // Stats server
        Logger.info("Started stats server on port " + port);
        setInterval(getStatsBind, this.config.serverStatsUpdate * 1000);
    }.bind(this));
};

/**
 * Get current connected player count (including dual players)
 * Returns number of actual human players connected (main + dual)
 */
GameServer.prototype.getCurrentPlayerCount = function () {
    var count = 0;
    for (var i = 0; i < this.clients.length; i++) {
        var socket = this.clients[i];
        if (socket && socket.isConnected && socket.playerTracker) {
            var tracker = socket.playerTracker;

            // Count REGULAR players
            if (tracker.playerType === 'REGULAR') {
                count++;
            }
            // Count DUAL_MINION players separately (they have their own socket in clients list)
            else if (tracker.playerType === 'DUAL_MINION' && !tracker.isRemoved) {
                count++;
            }
        }
    }
    return count;
};

GameServer.prototype.getStats = function () {
    // Get server statistics
    var totalPlayers = 0;
    var alivePlayers = 0;
    var spectatePlayers = 0;
    for (var i = 0, len = this.clients.length; i < len; i++) {
        var socket = this.clients[i];
        if (!socket || !socket.isConnected)
            continue;
        totalPlayers++;
        if (socket.playerTracker.cells.length) alivePlayers++;
        else spectatePlayers++;
    }
    var s = {
        'server_name': this.config.serverName,
        'server_chat': this.config.serverChat ? "true" : "false",
        'border_width': this.border.width,
        'border_height': this.border.height,
        'gamemode': this.gameMode.name,
        'max_players': this.config.serverMaxConnections,
        'current_players': totalPlayers,
        'alive': alivePlayers,
        'spectators': spectatePlayers,
        'update_time': this.updateTimeAvg.toFixed(3),
        'uptime': Math.round((this.stepDateTime - this.startTime) / 1000 / 60),
        'start_time': this.startTime
    };
    this.stats = JSON.stringify(s);
};

// Pings the server tracker, should be called every 30 seconds
// To list us on the server tracker located at http://ogar.mivabe.nl/master
GameServer.prototype.pingServerTracker = function () {
    // Get server statistics
    var os = require('os');
    var totalPlayers = 0;
    var alivePlayers = 0;
    var spectatePlayers = 0;
    var robotPlayers = 0;
    for (var i = 0, len = this.clients.length; i < len; i++) {
        var socket = this.clients[i];
        if (!socket || socket.isConnected == false)
            continue;
        if (socket.isConnected == null) {
            robotPlayers++;
        } else {
            totalPlayers++;
            if (socket.playerTracker.cells.length) alivePlayers++;
            else spectatePlayers++;
        }
    }

    // ogar-tracker.tk
    /*
    var obj = {
        port: this.config.serverPort,               // [mandatory] web socket port which listens for game client connections
        name: this.config.serverName,               // [mandatory] server name
        mode: this.gameMode.name,                   // [mandatory] game mode
        total: totalPlayers,                        // [mandatory] total online players (server bots is not included!)
        alive: alivePlayers,                        // [mandatory] alive players (server bots is not included!)
        spect: spectatePlayers,                     // [mandatory] spectate players (server bots is not included!)
        robot: robotPlayers,                        // [mandatory] server bots
        limit: this.config.serverMaxConnections,    // [mandatory] maximum allowed connection count
        protocol: 'M',                              // [mandatory] required protocol id or 'M' for multiprotocol (if all protocols is supported)
        uptime: process.uptime() >> 0,              // [mandatory] server uptime [seconds]
        w: this.border.width >> 0,                  // [mandatory] map border width [integer]
        h: this.border.height >> 0,                 // [mandatory] map border height [integer]
        version: 'Aetlis ' + this.version,       // [optional]  server version
        stpavg: this.updateTimeAvg >> 0,            // [optional]  average server loop time
        chat: this.config.serverChat ? 1 : 0,       // [optional]  0 - chat disabled, 1 - chat enabled
        os: os.platform()                           // [optional]  operating system
    };
    trackerRequest({
        host: 'ogar-tracker.tk',
        port: 80,
        path: '/api/ping',
        method: 'PUT'
    }, 'application/json', JSON.stringify(obj));
    */

    // mivabe.nl
    var data = 'current_players=' + totalPlayers +
        '&alive=' + alivePlayers +
        '&spectators=' + spectatePlayers +
        '&max_players=' + this.config.serverMaxConnections +
        '&sport=' + this.config.serverPort +
        '&gamemode=[**] ' + this.gameMode.name +             // we add [**] to indicate that this is Aetlis server
        '&agario=true' +                                     // protocol version
        '&name=Unnamed Server' +                             // we cannot use it, because other value will be used as dns name
        '&opp=' + os.platform() + ' ' + os.arch() +          // "win32 x64"
        '&uptime=' + process.uptime() +                      // Number of seconds server has been running
        '&version=Aetlis ' + this.version +
        '&start_time=' + this.startTime;
    trackerRequest({
        host: 'ogar.mivabe.nl',
        port: 80,
        path: '/master',
        method: 'POST'
    }, 'application/x-www-form-urlencoded', data);

    // c0nsume.me
    trackerRequest({
        host: 'c0nsume.me',
        port: 80,
        path: '/tracker.php',
        method: 'POST'
    }, 'application/x-www-form-urlencoded', data);
};

function trackerRequest(options, type, body) {
    if (options.headers == null) options.headers = {};
    options.headers['user-agent'] = 'Aetlis' + this.version;
    options.headers['content-type'] = type;
    options.headers['content-length'] = body == null ? 0 : Buffer.byteLength(body, 'utf8');
    var req = http.request(options, function (res) {
        if (res.statusCode != 200) {
            Logger.writeError("Tracker request for " + options.host + " returned status code " + res.statusCode);
            return;
        }
        Logger.write("Tracker request for " + options.host + " successful");
        res.setEncoding('utf8');
    });
    req.on('error', function (err) {
        Logger.writeError("Tracker request for " + options.host + " returned an error: " + err);
    });
    req.shouldKeepAlive = false;
    req.on('close', function () {
        req.destroy();
    });
    req.write(body);
    req.end();
}

// =====================================
// GAMESERVERS.JSON API SYSTEM

// =====================================

GameServer.prototype.updateGameserversJsonOnPlayerChange = function () {
    // Skip if API URL is not configured
    if (!this.config.gameserversApiUrl) {
        return;
    }

    var currentPlayers = this.getCurrentPlayerCount();
    this.updateGameserversJsonViaApi(currentPlayers);
};

/**
 * Send player count update to API server
 * @param {number} currentPlayers - Current number of connected players
 */
GameServer.prototype.updateGameserversJsonViaApi = function (currentPlayers) {
    var apiUrl = this.config.gameserversApiUrl;
    if (!apiUrl) {
        return;
    }

    try {
        var urlMod = require('url');
        var parsed = new urlMod.URL(apiUrl);
        var useHttps = parsed.protocol === 'https:';
        var httpMod = useHttps ? require('https') : require('http');

        // Request data - includes region for correct server matching
        // serverName MUST match gameservers.json gameMode exactly (FFA, Megasplit, Gigasplit, etc.)
        var requestData = {
            gameMode: this.config.serverName,
            serverName: this.config.serverName,
            region: this.config.gameserversRegion || 'EU',
            currentPlayers: currentPlayers
        };

        var postData = JSON.stringify(requestData);

        var options = {
            hostname: parsed.hostname,
            port: parsed.port || (useHttps ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': 'Bearer aetlis-gameservers-update-2024-secret-key'
            }
        };

        var serverName = this.config.serverName;
        var region = requestData.region;
        var req = httpMod.request(options, function (res) {
            var statusCode = res.statusCode;
            var responseData = '';

            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                responseData += chunk;
            });

            res.on('end', function () {
                if (statusCode >= 200 && statusCode < 300) {
                    Logger.info("[GAMESERVERS] Updated " + serverName + " (" + region + "): " + currentPlayers + " players");
                } else {
                    Logger.warn("[GAMESERVERS] API error " + statusCode + ": " + responseData);
                }
            });
        });

        req.on('error', function (err) {
            Logger.error("[GAMESERVERS] Request failed: " + err.message);
        });

        req.setTimeout(5000, function () {
            req.destroy();
            Logger.warn("[GAMESERVERS] Request timeout");
        });

        req.write(postData);
        req.end();

    } catch (err) {
        Logger.error("[GAMESERVERS] Error: " + err.message);
    }
};

// =====================================
// CHAT SYSTEM - Broadcast to everyone
// =====================================

/**
 * Send chat message to all connected players
 * @param {string} message - Message to broadcast
 */
GameServer.prototype.sendChatToAll = function (message) {
    for (var i = 0; i < this.clients.length; i++) {
        var client = this.clients[i];
        if (client && client.playerTracker) {
            this.sendChatMessage(null, client.playerTracker, message);
        }
    }
};

// =====================================
// AUTO-RESTART SYSTEM

// =====================================

/**
 * Start the auto-restart timer if enabled
 */
GameServer.prototype.startRestartTimer = function () {
    if (!this.config.serverRestartEnabled || this.config.serverRestartMinutes <= 0) {
        Logger.info("Auto-restart disabled");
        return;
    }

    var restartMilliseconds = this.config.serverRestartMinutes * 60 * 1000;
    var warning30Seconds = restartMilliseconds - 30000;
    var countdown10Seconds = restartMilliseconds - 10000;
    var self = this;

    Logger.info("Auto-restart enabled: Server will restart in " + this.config.serverRestartMinutes + " minutes");

    // Main restart timer
    this.restartTimer = setTimeout(function () {
        if (self.tournamentManager && self.tournamentManager.isActive) {
            Logger.info("[AUTO-RESTART] Cancelled due to active tournament");
            return;
        }
        self.executeRestart();
    }, restartMilliseconds);

    // 30 second warning - time to tell everyone their time is up
    this.restartWarningTimer = setTimeout(function () {
        if (self.tournamentManager && self.tournamentManager.isActive) {
            return;
        }
        self.sendChatToAll("Server restarting in 30 seconds!");
        Logger.warn("SERVER RESTART WARNING: 30 seconds remaining");

        // Send XP summary 1 second after warning
        setTimeout(function () {
            self.sendSessionXPSummary();
        }, 1000);
    }, warning30Seconds);

    // 10-1 countdown - the dramatic finale
    this.restartCountdownTimer = setTimeout(function () {
        if (self.tournamentManager && self.tournamentManager.isActive) {
            return;
        }
        self.startRestartCountdown();
    }, countdown10Seconds);
};

/**
 * Start the 10 second countdown before restart
 */
GameServer.prototype.startRestartCountdown = function () {
    var countdown = 10;
    var self = this;

    var countdownInterval = setInterval(function () {
        if (countdown > 0) {
            self.sendChatToAll("Server restarting in " + countdown);
            Logger.warn("SERVER RESTART COUNTDOWN: " + countdown);
            countdown--;
        } else {
            clearInterval(countdownInterval);
        }
    }, 1000);
};

/**
 * Execute the server restart
 * Saves all player XP, kicks everyone, and exits
 */
GameServer.prototype.executeRestart = function () {
    if (this.isRestarting) return;
    this.isRestarting = true;

    Logger.warn("═══════════════════════════════════════");
    Logger.warn("     SERVER RESTARTING NOW!");
    Logger.warn("═══════════════════════════════════════");

    // Send final message to all players
    this.sendChatToAll("Server Restarting...");

    // Calculate and save session time XP for all players before disconnect
    Logger.info("Calculating session time XP for all players...");
    var clientsCopy = this.clients.slice();
    for (var i = 0; i < clientsCopy.length; i++) {
        var client = clientsCopy[i];
        if (client && client.playerTracker) {
            try {
                var player = client.playerTracker;

                // Skip players without Discord token (no XP for anons)
                if (!player.discordToken) {
                    Logger.info('[SESSION-XP] Skipping player ' + player.pID + ' (no Discord token)');
                    continue;
                }

                // Stop active play tracking
                if (typeof player.stopActivePlay === 'function') {
                    player.stopActivePlay();
                }

                // Calculate session time XP
                if (typeof player.calculateSessionTimeXP === 'function') {
                    var sessionTimeXPResult = player.calculateSessionTimeXP();
                    var sessionTimeXP = sessionTimeXPResult.seasonXP || sessionTimeXPResult.totalXP || 0;
                    if (sessionTimeXP > 0) {
                        player.sessionXP = (player.sessionXP || 0) + sessionTimeXP;
                        var activeMinutes = player.getActivePlayTimeMinutes ? player.getActivePlayTimeMinutes() : 0;
                        Logger.info('[SESSION-XP] Player ' + player.pID + ' earned ' + sessionTimeXP + ' XP for ' + activeMinutes + ' active minutes');
                    }
                }

                // Stop AFK checking
                if (typeof player.stopAFKCheck === 'function') {
                    player.stopAFKCheck();
                }

                // Save to API
                if (typeof player.saveSessionToAPI === 'function') {
                    player.saveSessionToAPI();
                }
            } catch (err) {
                Logger.error('Error saving player session: ' + err.message);
            }
        }
    }

    // Disconnect all clients - party's over folks
    for (var i = 0; i < clientsCopy.length; i++) {
        var client = clientsCopy[i];
        if (client && client.isConnected) {
            try {
                client.close(1000, "Server Restarting...");
            } catch (err) {
                // Ignore errors during shutdown
            }
        }
    }

    // Clear client array
    this.clients = [];

    // Give a moment for connections to close, then exit
    setTimeout(function () {
        Logger.info("Server shutdown complete. Exiting process...");
        process.exit(0);
    }, 2000);
};

// =====================================
// SESSION XP SUMMARY
// Show off who grinded the hardest
// =====================================

/**
 * Send XP summary to all players before restart
 * Shows top players and their XP earned this session
 */
// =====================================
// NAME LOCK SYSTEM
// Protect reserved names from imposters
// =====================================

/**
 * Check if a name is locked by another user via API
 * @param {string} name - The name to check
 * @param {string} discordToken - The player's discord token (optional)
 * @param {function} callback - Callback(err, result) where result = {locked, isOwner}
 */
GameServer.prototype.checkNameLock = function (name, discordToken, callback) {
    if (!name || name.length === 0) {
        callback(null, { locked: false, isOwner: false });
        return;
    }

    // Strip clan tags from name (format: <tag>name)
    var cleanName = name;
    if (name[0] === '<') {
        var tagEnd = name.indexOf('>');
        if (tagEnd >= 1) {
            cleanName = name.slice(tagEnd + 1);
        }
    }
    cleanName = cleanName.trim();

    if (!cleanName || cleanName.length === 0) {
        callback(null, { locked: false, isOwner: false });
        return;
    }

    var https = require('https');

    // Build API request options
    var options = {
        hostname: 'aetlis.io',
        port: 443,
        path: '/api/check-name-lock?name=' + encodeURIComponent(cleanName),
        method: 'GET',
        headers: {}
    };

    // Add authorization if player has discord token
    if (discordToken && discordToken.length > 0) {
        options.headers['Authorization'] = 'Vanis ' + discordToken;
    }

    // Make HTTPS request
    var req = https.request(options, function (res) {
        var data = '';

        res.on('data', function (chunk) {
            data += chunk;
        });

        res.on('end', function () {
            try {
                var result = JSON.parse(data);
                // result.locked = true/false (if name is locked)
                // result.isOwner = true/false (if player owns this locked name)
                callback(null, result);
            } catch (err) {
                Logger.error('[NAME-LOCK] Failed to parse API response: ' + err.message);
                callback(err, null);
            }
        });
    });

    req.on('error', function (err) {
        Logger.error('[NAME-LOCK] API request failed: ' + err.message);
        callback(err, null);
    });

    req.setTimeout(3000, function () {
        req.destroy();
        Logger.error('[NAME-LOCK] API request timeout');
        callback(new Error('Timeout'), null);
    });

    req.end();
};

GameServer.prototype.sendSessionXPSummary = function () {
    Logger.info('[TOP-PLAYERS] sendSessionXPSummary called. Total clients: ' + this.clients.length);

    // Calculate XP summary for all players
    var playerSummaries = [];

    for (var i = 0; i < this.clients.length; i++) {
        var client = this.clients[i];
        if (client && client.playerTracker && !client.playerTracker.isMinion) {
            var player = client.playerTracker;

            // Skip players without Discord token
            if (!player.discordToken) {
                continue;
            }

            // Calculate total XP for this session
            var sessionTimeXP = 0;
            if (typeof player.calculateSessionTimeXP === 'function') {
                var result = player.calculateSessionTimeXP();
                sessionTimeXP = result.seasonXP || result.totalXP || 0;
            }
            var totalSessionXP = (player.sessionXP || 0) + sessionTimeXP;

            // Get active play time
            var activePlayMinutes = 0;
            if (typeof player.getActivePlayTimeMinutes === 'function') {
                activePlayMinutes = player.getActivePlayTimeMinutes();
            }

            // Must have at least 1 minute of active play and XP > 0
            if (totalSessionXP > 0 && activePlayMinutes >= 1) {
                playerSummaries.push({
                    name: player._name || "Unnamed",
                    xp: totalSessionXP,
                    minutesPlayed: activePlayMinutes
                });
            }
        }
    }

    // Sort by XP (highest first) - may the best grinder win
    playerSummaries.sort(function (a, b) {
        return b.xp - a.xp;
    });

    Logger.info('[TOP-PLAYERS] Collected ' + playerSummaries.length + ' eligible players for summary');

    // Minimum 3 players required for Top Players
    if (playerSummaries.length < 3) {
        Logger.info('[TOP-PLAYERS] Not enough players (' + playerSummaries.length + '/3). Skipping announcement.');
        return;
    }

    // Build cleaner summary message
    this.sendChatToAll(" ");
    this.sendChatToAll("--- TOP PLAYERS THIS SESSION ---");
    this.sendChatToAll(" ");

    // Send top 5 players with rank
    var showCount = Math.min(playerSummaries.length, 5);
    for (var i = 0; i < showCount; i++) {
        var summary = playerSummaries[i];
        var rank = "#" + (i + 1);
        var msg = rank + " " + summary.name + " - " + summary.xp + " XP (" + summary.minutesPlayed + "m)";
        this.sendChatToAll(msg);
    }

    // Calculate total XP
    var totalXP = 0;
    for (var i = 0; i < playerSummaries.length; i++) {
        totalXP += playerSummaries[i].xp;
    }

    this.sendChatToAll(" ");
    this.sendChatToAll("Total: " + totalXP + " XP earned by " + playerSummaries.length + " players");
    this.sendChatToAll("--------------------------------");
    this.sendChatToAll(" ");
};

// reverseSplitOrder - MUST be called before collision
GameServer.prototype.reverseSplitOrder = function () {
    // Reverse the order of player cells for split operations
    // This ensures proper split behavior before collision detection
    if (this.nodesPlayer.length > 1) {
        this.nodesPlayer.reverse();
    }
};

// =====================================
// WINNER SYSTEM FUNCTIONS
// Handle mass threshold victory
// =====================================

/**
 * Send winner message to all clients
 * Format: WINNER|name|seconds - client parses this and shows overlay
 */
GameServer.prototype.sendWinnerMessage = function (name, seconds) {
    var msg = "WINNER|" + name + "|" + seconds;
    for (var i = 0; i < this.clients.length; i++) {
        if (this.clients[i] && this.clients[i].playerTracker) {
            this.sendChatMessage(null, this.clients[i].playerTracker, msg);
        }
    }
};

/**
 * Cancel winner countdown (e.g., winner died or lost mass)
 * Resets all winner state and notifies clients to hide overlay
 */
GameServer.prototype.cancelWinnerCountdown = function () {
    // Reset countdown state
    this.winnerCountdownActive = false;
    this.winnerCountdownStartTick = 0;
    this.winnerPlayer = null;
    this.winnerName = "";
    this.lastWinnerMessageTick = 0;
    this.isRestarting = false;

    // Notify all clients to hide the overlay
    var msg = "WINNER_CANCEL";
    for (var i = 0; i < this.clients.length; i++) {
        if (this.clients[i] && this.clients[i].playerTracker) {
            this.sendChatMessage(null, this.clients[i].playerTracker, msg);
        }
    }
};

/**
 * Execute server restart after winner countdown completes
 * Sends XP summary, saves all player data, and exits
 */
GameServer.prototype.executeRestart = function () {
    if (this.isRestarting) return;
    this.isRestarting = true;

    Logger.warn("═══════════════════════════════════════");
    Logger.warn("     SERVER RESTARTING NOW!");
    Logger.warn("═══════════════════════════════════════");

    // Send final message to all players
    this.sendChatToAll("Server Restarting...");

    // Send XP summary before restart
    if (typeof this.sendSessionXPSummary === 'function') {
        this.sendSessionXPSummary();
    }

    // Calculate and save session time XP for all players before disconnect
    Logger.info("Calculating session time XP for all players...");
    var clientsCopy = this.clients.slice();
    for (var i = 0; i < clientsCopy.length; i++) {
        var client = clientsCopy[i];
        if (client && client.playerTracker) {
            try {
                var player = client.playerTracker;

                // Skip players without Discord token
                if (!player.discordToken) {
                    continue;
                }

                // Stop active play tracking
                if (typeof player.stopActivePlay === 'function') {
                    player.stopActivePlay();
                }

                // Calculate session time XP
                if (typeof player.calculateSessionTimeXP === 'function') {
                    var sessionTimeXPResult = player.calculateSessionTimeXP();
                    var sessionTimeXP = sessionTimeXPResult.seasonXP || 0;
                    if (sessionTimeXP > 0) {
                        player.sessionXP = (player.sessionXP || 0) + sessionTimeXP;
                    }
                }

                // Stop AFK checking
                if (typeof player.stopAFKCheck === 'function') {
                    player.stopAFKCheck();
                }

                // Save to API
                if (typeof player.saveSessionToAPI === 'function') {
                    player.saveSessionToAPI();
                }
            } catch (err) {
                Logger.error('Error saving player session: ' + err.message);
            }
        }
    }

    // Disconnect all clients
    for (var i = 0; i < clientsCopy.length; i++) {
        var client = clientsCopy[i];
        if (client && client.isConnected) {
            try {
                client.close(1000, "Server Restarting...");
            } catch (err) {
                // Ignore errors during shutdown
            }
        }
    }

    // Clear client array
    this.clients = [];

    // FORCE KILL immediately - PM2 will restart
    setTimeout(function () {
        Logger.info("FORCE KILL - SIGKILL NOW!");
        process.kill(process.pid, 'SIGKILL');
    }, 500);
};

// =====================================
// COLLISION OPTIMIZATION METHODS
// Engine-style optimizations to reduce lag with many cells
// Only active when config.collisionOptimization = 1
// =====================================

/**
 * Get a manifold from the pool (avoids allocation/GC)
 * @returns {{cell: any, check: any, d: number, dSq: number, dx: number, dy: number}}
 */
GameServer.prototype._getManifold = function () {
    if (this._manifoldPoolIndex < this._manifoldPool.length) {
        return this._manifoldPool[this._manifoldPoolIndex++];
    }
    var m = { cell: null, check: null, d: 0, dSq: 0, dx: 0, dy: 0 };
    this._manifoldPool.push(m);
    this._manifoldPoolIndex++;
    return m;
};

/**
 * Get an eat collision object from pool
 */
GameServer.prototype._getEatCollision = function () {
    if (this._eatCollisionsPool.length > 0) {
        return this._eatCollisionsPool.pop();
    }
    return { manifold: null, cell: null, check: null };
};

/**
 * Return eat collision to pool
 */
GameServer.prototype._returnEatCollision = function (ec) {
    ec.manifold = null;
    ec.cell = null;
    ec.check = null;
    this._eatCollisionsPool.push(ec);
};

/**
 * Reset pools at tick start
 */
GameServer.prototype._resetOptimizationPools = function () {
    this._manifoldPoolIndex = 0;
    this._skipTickId++;
    // Don't clear pendingQuadUpdates - it should be empty from last flush
};

/**
 * Optimized collision check using squared distance (avoids sqrt)
 * @param {Cell} cell 
 * @param {Cell} check 
 * @returns {Object} manifold with dSq (squared distance)
 */
GameServer.prototype._checkCollisionOptimized = function (cell, check) {
    var dx = check.position.x - cell.position.x;
    var dy = check.position.y - cell.position.y;
    var dSq = dx * dx + dy * dy;

    var m = this._getManifold();
    m.cell = cell;
    m.check = check;
    m.dSq = dSq;
    m.dx = dx;
    m.dy = dy;
    m.d = 0; // Lazy - only calculate sqrt when needed
    return m;
};

/**
 * Get actual distance from manifold
 */
GameServer.prototype._getDistance = function (m) {
    if (m.d === 0 && m.dSq > 0) {
        m.d = Math.sqrt(m.dSq);
    }
    return m.d;
};

/**
 * Queue a node for quad update (batch mode)
 */
GameServer.prototype._queueQuadUpdate = function (node) {
    if (!node._quadUpdateQueued) {
        node._quadUpdateQueued = true;
        this._pendingQuadUpdates.push(node);
    }
};

/**
 * Flush all pending quad updates at once
 */
GameServer.prototype._flushQuadUpdates = function () {
    var updates = this._pendingQuadUpdates;
    for (var i = 0; i < updates.length; i++) {
        var node = updates[i];
        node._quadUpdateQueued = false;
        this.updateNodeQuad(node);
    }
    this._pendingQuadUpdates.length = 0;
};

/**
 * Check if cell should be skipped this tick (already processed)
 */
GameServer.prototype._shouldSkipCell = function (cell) {
    return cell._skipTickId === this._skipTickId;
};

/**
 * Mark cell as processed this tick
 */
GameServer.prototype._markCellProcessed = function (cell) {
    cell._skipTickId = this._skipTickId;
};

// =====================================
// COLLISION LOGGING METHODS
// Debug logging for collision mechanics
// =====================================

/**
 * Check if collision logging is enabled for a player
 * @param {number} playerId - The player ID to check
 * @returns {boolean} True if logging is enabled for this player
 */
GameServer.prototype._shouldLogCollision = function (playerId) {
    return this.collisionLogPlayerIds.size > 0 &&
        this.collisionLogPlayerIds.has(playerId);
};

/**
 * Add a collision log entry (buffered per tick to prevent spam)
 * @param {number} playerId - The player ID this log belongs to
 * @param {string} category - Log category (SPLIT, BOOST, RIGID-COLLI, EAT, etc.)
 * @param {Object} data - Log data object
 */
GameServer.prototype._addCollisionLog = function (playerId, category, data) {
    if (!this._shouldLogCollision(playerId)) return;
    this._collisionLogBuffer.push({
        tick: this.tickCounter,
        playerId: playerId,
        category: category,
        data: data
    });
};

/**
 * Print a single collision log entry
 * @param {Object} log - The log entry to print
 */
GameServer.prototype._printCollisionLog = function (log) {
    var data = log.data;
    var parts = [];

    // Build readable output based on category
    for (var key in data) {
        if (data.hasOwnProperty(key)) {
            var val = data[key];
            if (typeof val === 'object' && val !== null) {
                // Handle position objects
                if (val.x !== undefined && val.y !== undefined) {
                    parts.push(key + '=(' + val.x + ',' + val.y + ')');
                } else if (Array.isArray(val)) {
                    parts.push(key + '=[' + val.length + ' items]');
                } else {
                    parts.push(key + '=' + JSON.stringify(val));
                }
            } else {
                parts.push(key + '=' + val);
            }
        }
    }

    console.log('  [' + log.category + '] ' + parts.join(' | '));
};

/**
 * Flush collision logs at end of tick (prevents spam)
 * Groups logs by category and summarizes if too many entries
 */
GameServer.prototype._flushCollisionLogs = function () {
    if (this._collisionLogBuffer.length === 0) return;

    // Group by category for cleaner output
    var byCategory = {};
    for (var i = 0; i < this._collisionLogBuffer.length; i++) {
        var log = this._collisionLogBuffer[i];
        if (!byCategory[log.category]) byCategory[log.category] = [];
        byCategory[log.category].push(log);
    }

    // Print summary header
    var playerIds = [];
    this.collisionLogPlayerIds.forEach(function (id) { playerIds.push(id); });
    console.log('\n[COLLI-LOG] Tick ' + this.tickCounter + ' | Players: ' + playerIds.join(',') + ' | Events: ' + this._collisionLogBuffer.length);
    console.log('────────────────────────────────────────────────');

    // Print each category with smart summarization
    for (var cat in byCategory) {
        if (!byCategory.hasOwnProperty(cat)) continue;
        var logs = byCategory[cat];

        if (logs.length > 5) {
            // Summarize if too many entries
            console.log('[' + cat + '] ' + logs.length + ' events (showing first 3):');
            for (var j = 0; j < 3; j++) {
                this._printCollisionLog(logs[j]);
            }
            console.log('  ... and ' + (logs.length - 3) + ' more');
        } else {
            console.log('[' + cat + '] ' + logs.length + ' events:');
            for (var j = 0; j < logs.length; j++) {
                this._printCollisionLog(logs[j]);
            }
        }
    }

    this._collisionLogBuffer = [];
    this._collisionLogLastTick = this.tickCounter;
};
