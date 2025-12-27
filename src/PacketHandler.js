// PacketHandler.js - Combined Legacy + Vanis Protocol Support
// This shit handles both old MultiOgar clients and new Vanis clients
// Because backwards compatibility is sexy

var Packet = require('./packet');
var BinaryReader = require('./packet/BinaryReader');
var VanisReader = require('./packet/VanisReader');
var VanisWriter = require('./packet/VanisWriter');
var Logger = require('./modules/Logger');

function PacketHandler(gameServer, socket) {
    this.gameServer = gameServer;
    this.socket = socket;
    this.protocol = 0;
    this.handshakeProtocol = null;
    this.handshakeKey = null;
    this.lastJoinTick = 0;
    this.lastChatTick = 0;
    this.lastStatTick = 0;
    this.lastWTick = 0;
    this.lastQTick = 0;
    this.lastSpaceTick = 0;
    this.pressQ = false;
    this.pressW = false;
    this.pressSpace = false;
    this.mouseData = null;

    // Vanis protocol state
    this.isVanis = false;
    this.vanisHandshakeStage = 0;
    this._initialWorldSent = false;
    this._handshakeReceived = false;

    // Feed key tracking for dual switching
    this.feedKeyHeld = false;
    this.feedKeyOwnerId = -1;

    // ========================================
    // PACKET THROTTLING (25 packets/second)
    // this shit actually usefull unless its not 25 p/s anymore
    // ========================================
    this.packetCount = 0;
    this.packetResetTime = Date.now();
    this.packetThrottleWarnings = 0;
    this.PACKET_RATE_LIMIT = 65;  // Max packets per second (increased to 65)
    this.PACKET_THROTTLE_KICK_THRESHOLD = 5;  // Warnings before kick

    // ========================================
    // CAPTCHA & SECURITY STATE
    // The wall against bots and script kiddies
    // ========================================
    var securityCfg = (gameServer.config && gameServer.config.security) || {};
    var disableCaptcha = !!(securityCfg.disableCaptchaVerification || gameServer.config.disableCaptchaVerification);
    this.captchaRequired = !disableCaptcha;
    // Auto-verify bots - they don't need no stinkin' captcha
    var isBot = !!(socket && socket.isBot);
    this.socket.captchaVerified = !this.captchaRequired || isBot; // Auto-verified if captcha disabled OR it's a bot
    this.captchaDeadline = (this.captchaRequired && !isBot) ? (Date.now() + 60000) : null; // 60s to complete captcha (bots exempt)

    // Discord bypass state tracking
    this.socket.discordBypass = false;
    this.socket.discordBypassValidated = false;
    this.socket.discordUserId = null; // Store Discord User ID for rate limiting

    // Legacy handler map should we delete this or naaaaa?
    this.handler = {
        254: this.handshake_onProtocol.bind(this),
    };
}

module.exports = PacketHandler;

// =====================================
// MESSAGE HANDLING - The brain of this thing
// =====================================

PacketHandler.prototype.handleMessage = function (message) {
    this.gameServer.downloadUsage += 448;

    if (!message || !message.length) return;

    // Check for Vanis handshake (4 bytes: 69, 420 magic)
    if (!this.isVanis && this.vanisHandshakeStage === 0 && message.length === 4) {
        if (this.handleVanisHandshake(message)) {
            return;
        }
    }

    // Route to Vanis handler if we're in Vanis mode
    if (this.isVanis) {
        this.handleVanisMessage(message);
        return;
    }

    // Legacy MultiOgar protocol handling
    var opcode = message[0];
    if (!this.handler.hasOwnProperty(opcode)) return;

    this.gameServer.downloadUsage += message.length * 8;
    this.handler[opcode](message);
    this.socket.lastAliveTime = this.gameServer.stepDateTime;
};

// =====================================
// VANIS PROTOCOL - my ass
// Magic bytes: 69, 420 (an fucking classic)
// =====================================

PacketHandler.prototype.handleVanisHandshake = function (message) {
    if (this.vanisHandshakeStage >= 1) return true;
    if (!message || message.length !== 4) return false;

    var reader = new VanisReader(message);
    var magic1 = reader.readUInt16();
    var magic2 = reader.readUInt16();

    // 69 420 - The sacred numbers
    if (magic1 !== 69 || magic2 !== 420) {
        return false;
    }

    this.isVanis = true;
    this.protocol = 99; // Set high protocol so sendUpdate works
    this.vanisHandshakeStage = 1;
    this._handshakeReceived = true;

    // Log captcha status
    if (this.captchaRequired) {
        Logger.info('[VANIS]  Handshake received (69, 420) - Awaiting hCaptcha verification');
    } else {
        Logger.info('[VANIS]  Handshake received (69, 420) - Captcha disabled via config');
    }

    // Send initial world (captcha check is separate - player can see world, but can't spawn)
    this._sendInitialWorldIfReady();

    return true;
};

// Send initial world to client - they can see but can't spawn until captcha verified
PacketHandler.prototype._sendInitialWorldIfReady = function () {
    if (this._initialWorldSent) return;
    if (!this.socket || !this.socket.isConnected) return;

    // Set flag BEFORE sending to allow sendVanisPlayerInfo to work
    this._initialWorldSent = true;
    this.sendVanisInitialWorld();
    Logger.debug('[VANIS] Initial world sent');

    // TOURNAMENT MODE: Send ForceSpectate IMMEDIATELY on connect
    // Everyone starts as spectator, registered players get unblocked after Discord verification
    var gameServer = this.gameServer;
    if (gameServer && gameServer.tournamentData && gameServer.tournamentData.enabled) {
        Logger.info('[TOURNAMENT] Sending immediate ForceSpectate to new connection');
        this.sendVanisForceSpectate();

        // Mark player as initially blocked (will be unblocked if registered)
        if (this.socket.playerTracker) {
            this.socket.playerTracker._tournamentSpawnBlocked = true;
            this.socket.playerTracker._tournamentSpectateInitialized = true;
        }
    }
};

PacketHandler.prototype.handleVanisMessage = function (message) {
    if (!message || !message.length) return;

    var reader = new VanisReader(message);
    var opcode = reader.readUInt8();

    // ========================================
    // PACKET THROTTLING CHECK
    // Skip throttle for essential packets (ping, mouse)
    // ========================================
    var exemptOpcodes = [3, 15, 16, 18, 23, 25, 46, 99]; // 3=Ping, 15=Linelock, 16=Mouse, 18=SpecialLinesplit, 23/25=Multibox/TabSwitch, 46=DiagonalLinesplit, 99=Chat
    if (exemptOpcodes.indexOf(opcode) === -1) {
        var now = Date.now();

        // Reset counter every second
        if (now - this.packetResetTime >= 1000) {
            this.packetCount = 0;
            this.packetResetTime = now;
        }

        this.packetCount++;

        // Check rate limit
        if (this.packetCount > this.PACKET_RATE_LIMIT) {
            this.packetThrottleWarnings++;

            // Log every 5th warning
            if (this.packetThrottleWarnings % 5 === 1) {
                Logger.debug('[THROTTLE] Packet rate exceeded for socket - ' + this.packetCount + '/s (warning ' + this.packetThrottleWarnings + ')');
            }

            // Kick if too many warnings
            if (this.packetThrottleWarnings >= this.PACKET_THROTTLE_KICK_THRESHOLD) {
                Logger.warn('[THROTTLE] Kicking client for excessive packet rate');
                try { this.socket.close(1008, 'Too many packets'); } catch (e) { }
                return;
            }

            return; // Drop this packet
        }
    }

    // Handle opcodes - keep it simple, don't overthink this shit
    switch (opcode) {
        case 1: // Join/Spawn
            this.handleVanisJoin(reader);
            break;
        case 2: // Spectate
            this.handleVanisSpectate(reader);
            break;
        case 3: // Ping
            this.sendVanisPing();
            break;
        case 4: // Player info (nickname + token)
            this.handleVanisPlayerInfo(reader);
            break;
        case 15: // Toggle generic linelock
            this.handleVanisLinelock(reader);
            break;
        case 16: // Mouse move
            this.handleVanisMouse(reader);
            break;
        case 17: // Split
            this.handleVanisSplit(reader);
            break;
        case 18: // Special linesplit lock
            this.handleVanisSpecialLinelock(reader);
            break;
        case 21: // Feed/Eject
            this.handleVanisFeed(reader);
            break;
        case 46: // Diagonal linesplit notice
            this.handleVanisDiagonalLinesplitNotice();
            break;
        case 99: // Chat
            this.handleVanisChat(reader);
            break;

        // ========================================
        // CAPTCHA/SECURITY PACKETS
        // 
        // ========================================
        case 251: // hCaptcha token
            this.handleVanisCaptchaToken(reader);
            break;

        // ========================================
        // DUAL PLAYER  PACKETS
        // 
        // ========================================
        case 23: // Switch Multibox (toggle active player)
            this.handleSwitchMultibox();
            break;
        case 25: // Create Dual Player
            this.handleRequestCreateDual();
            break;
        case 26: // Remember ejecting preference
            this.handleVanisPreferenceToggle(26, reader);
            break;
        case 27: // Minion control preference
            this.handleVanisPreferenceToggle(27, reader);
            break;
        case 28: // Lock inactive position preference
            this.handleVanisPreferenceToggle(28, reader);
            break;
        case 29: // Remember mouse position preference
            this.handleVanisPreferenceToggle(29, reader);
            break;
        case 30: // Set Dual Nickname
            this.handleVanisDualNickname(reader);
            break;
        case 31: // Set Dual Skin URL
            this.handleVanisDualSkin(reader);
            break;

        // Dual minion commands (32-45)
        case 32: case 33: case 34: case 35:
        case 36: case 37: case 38: case 39:
        case 40: case 41: case 42: case 43:
        case 44: case 45:
            Logger.debug('[DUAL-MINION] 📦 Packet received opcode=' + opcode + ' (dual minion command)');
            this.handleDualMinionCommand(opcode, reader);
            break;

        // ========================================
        // TOURNAMENT SYSTEM PACKETS
        // Referee controls and tournament commands
        // ========================================
        case 55: // Tournament command from client (referee only)
            this.handleTournamentCommand(reader);
            break;

        default:
            // Unknown opcode, probably fine
            break;
    }

    this.socket.lastAliveTime = this.gameServer.stepDateTime;
};

// =====================================
// VANIS HANDLERS - Where the magic happens
// =====================================

// Helper: Read all UTF8 strings from buffer
PacketHandler.prototype._readUtf8Strings = function (reader) {
    var parts = [];
    if (!reader || !reader.buffer) return parts;
    try {
        while (reader.offset < reader.buffer.length) {
            var value = reader.readStringUTF8();
            if (typeof value === 'string') {
                parts.push(value);
            }
        }
    } catch (err) {
        // Ignore malformed tail; preserve whatever we parsed
    } finally {
        reader.offset = reader.buffer.length;
    }
    return parts;
};

// Helper: Check if string looks like a discord token (really?)
PacketHandler.prototype._looksLikeDiscordToken = function (value) {
    if (!value || typeof value !== 'string') return false;
    if (value === '0' || value === '1') return false;
    return value.length > 24 && value.indexOf('.') !== -1;
};

// Helper: Extract token and autoRespawn from parts 
PacketHandler.prototype._extractTokenAndAutoRespawn = function (parts) {
    var work = parts.slice();
    var autoRespawn = true;
    var token = null;

    // Last element might be autoRespawn flag (0 or 1) 
    if (work.length) {
        var last = work[work.length - 1];
        if (last === '0' || last === '1') {
            autoRespawn = last === '1';
            work.pop();
        }
    }

    // Next-to-last might be discord token (seriously?)
    if (work.length) {
        var candidate = work[work.length - 1];
        if (this._looksLikeDiscordToken(candidate)) {
            token = candidate;
            work.pop();
        }
    }

    return { token: token, autoRespawn: autoRespawn, parts: work };
};

// Helper: Parse the join payload properly
PacketHandler.prototype._parseVanisJoinPayload = function (reader) {
    var parts = this._readUtf8Strings(reader);
    var extraction = this._extractTokenAndAutoRespawn(parts);
    var work = extraction.parts;

    var payload = {
        rawParts: parts,
        name: null,
        skin: '',
        tag: '',
        token: extraction.token,
        autoRespawn: extraction.autoRespawn
    };

    // Client sends: [nickname, skin, tag, discordToken, autoRespawn]
    // After extraction, work = [nickname, skin, tag] 
    if (work.length >= 3) {
        payload.name = work[0];
        payload.skin = work[1];
        payload.tag = work[2];
    } else if (work.length === 2) {
        payload.name = work[0];
        payload.skin = work[1];
    } else if (work.length === 1) {
        payload.name = work[0];
    }

    // Normalize
    if (payload.name) payload.name = payload.name.trim();
    payload.skin = payload.skin ? payload.skin.trim() : '';
    payload.tag = payload.tag ? payload.tag.trim() : '';

    return payload;
};

PacketHandler.prototype.handleVanisJoin = function (reader) {
    Logger.info('[VANIS] Join request received');

    var player = this.socket.playerTracker;
    if (!player) return;

    // Determine if this is a dual respawn attempt
    var isDualRespawn = player.isDualActive && player.dualPlayer && player.dualPlayer.cells.length === 0;

    // Tournament spawn control - check cooldown FIRST before anything else
    var tm = this.gameServer.tournamentManager;
    if (tm && tm.isActive) {
        // Block during PAUSE completely
        if (tm.isPaused) {
            Logger.debug('[VANIS] Join rejected - tournament paused');
            return;
        }

        // Check respawn cooldown for tournament players
        if (player.discordId) {
            var cooldownCheck = tm.checkRespawnCooldown(player.discordId);
            Logger.info('[TOURNAMENT] Cooldown check: canRespawn=' + cooldownCheck.canRespawn + ' remaining=' + cooldownCheck.remainingTime.toFixed(1) + 's isDual=' + isDualRespawn);

            if (!cooldownCheck.canRespawn) {
                // Send cooldown notification to client
                this.sendRespawnCooldown(cooldownCheck.remainingTime, isDualRespawn);
                Logger.info('[VANIS] Join rejected - respawn cooldown: ' + cooldownCheck.remainingTime.toFixed(1) + 's');
                return;
            }
        }
        // Frozen state: main player spawn allowed (for initial spawn)
        // Auto-respawn is blocked by isRespawnBlocked anyway
    }

    var tick = this.gameServer.tickCounter;
    var dt = tick - this.lastJoinTick;

    // Basic rate limit - ALWAYS enforce minimum delay between join attempts
    // This prevents spam regardless of tournament mode
    // TERASPLIT MODE: Increase delay to prevent respawn spamming (75 ticks = ~3 seconds)
    var minDelay = this.gameServer.config.terasplitMode ? 75 : 25;
    if (dt < minDelay) {
        Logger.debug('[VANIS] Join rejected - rate limit (dt=' + dt + ' ticks, min=' + minDelay + ')');
        return;
    }
    this.lastJoinTick = tick;
    if (!player) return;

    // Parse join payload using helper
    var payload = this._parseVanisJoinPayload(reader);

    // Set tag for isolation - this is crucial for the tag system
    player._tag = payload.tag || "";
    player.clientAutoRespawnEnabled = payload.autoRespawn;

    var name = payload.name || 'Unnamed';
    var skin = payload.skin || '';
    var self = this;

    // Handle discord token if provided
    if (payload.token) {
        player.discordToken = payload.token;
        Logger.debug('[VANIS] Discord token set for player');

        // =====================================
        // INSTANT NICKNAME LOG ON CONNECTION
        // Log player nickname immediately when they connect with token
        // This ensures a!find-user works even if they leave quickly
        // =====================================
        if (payload.name && payload.name.length > 0) {
            var tempPlayer = {
                discordToken: payload.token,
                _name: payload.name,
                pID: player.pID
            };
            this._updateDisplayNameToAPI(tempPlayer);
        }
    }

    // ========================================
    // CAPTCHA VERIFICATION CHECK
    // No captcha = no spawn
    // Discord bypass allowed only with VALID Discord ID
    // ========================================
    if (this.captchaRequired && !this.socket.captchaVerified) {
        // Check if they have a discord token for bypass
        if (!payload.token) {
            Logger.warn('[VANIS] Join rejected - captcha not verified and no Discord token');
            this._closeSocket(1008, 'You are not smart enough to join this server.');
            return;
        }

        // Validate Discord token before allowing bypass
        var tokenValid = this._validateDiscordTokenSync(payload.token);
        if (!tokenValid) {
            Logger.warn('[VANIS] Join rejected - Discord token invalid for captcha bypass');
            this._closeSocket(1008, 'You are not smart enough to join this server.');
            return;
        }

        // Token valid - mark as verified
        this.socket.captchaVerified = true;
        this.captchaDeadline = null;
        Logger.info('[CAPTCHA]  Discord token bypass verified for join');
    }

    // Clean up name first
    if (name.length > this.gameServer.config.playerMaxNickLength) {
        name = name.substring(0, this.gameServer.config.playerMaxNickLength);
    }

    // Check bad words (old fashion check)
    if (this.gameServer.checkBadWord(name)) {
        name = 'Hi there!';
    }

    // Check name lock BEFORE spawning (for somewhat this thing is not working maybe api fucked up or idk)
    this.gameServer.checkNameLock(name, player.discordToken, function (err, result) {
        var finalName = name;

        if (err) {
            // API error - allow with original name
            Logger.debug('[NAME-LOCK] API check failed, allowing spawn: ' + err.message);
        } else if (result && result.locked && !result.isOwner) {
            // Name is locked by another user - spawn as unnamed
            Logger.debug('[NAME-LOCK]  Locked name used, spawning as unnamed: ' + name);
            self.sendVanisChat(null, ' This name is locked by another player!');
            finalName = 'Unnamed';
        } else if (result && result.locked && result.isOwner) {
            Logger.debug('[NAME-LOCK]  Player is owner of locked name: ' + name);
        } else {
            Logger.debug('[NAME-LOCK]  Name is not locked: ' + name);
        }

        self._completeJoin(player, finalName, skin, payload.token);
    });
};

/**
 * Complete the join process after name lock check
 * Now properly handles dual player spawning
 */
PacketHandler.prototype._completeJoin = function (player, name, skin, hasToken) {
    var self = this;

    // get the correct target player for spawning
    // This handles dual player respawn when isDualActive is true
    var targetPlayer = this.getSpawnTargetPlayer();
    if (!targetPlayer) {
        Logger.warn('[VANIS] No target player for spawn, using main player');
        targetPlayer = player;
    }

    // Determine if we're spawning main or dual
    var isSpawningDual = (targetPlayer.playerType === 'DUAL_MINION');
    var spawnContext = isSpawningDual ? 'manual_dual' : 'manual';

    //  Save cell count BEFORE we spawn dead cells
    // This determines spawn behavior:
    // - Had 0 cells (dead) → spawn near death position
    // - Had 1+ cells (alive) → spawn randomly (not near death)
    var hadCellsBeforeRespawn = targetPlayer.cells.length > 0;
    var allowRespawnWithCells = hadCellsBeforeRespawn;

    Logger.info('[VANIS-SPAWN] ========================================');
    Logger.info('[VANIS-SPAWN] Target: ' + (isSpawningDual ? 'DUAL' : 'MAIN') + ' PID=' + targetPlayer.pID);
    Logger.info('[VANIS-SPAWN] Main PID=' + player.pID + ' isDualActive=' + player.isDualActive);
    Logger.info('[VANIS-SPAWN] HadCells=' + hadCellsBeforeRespawn + ' Context=' + spawnContext);
    Logger.info('[VANIS-SPAWN] ========================================');

    // Load XP and perks from API, then send "Logged in as" message
    if (hasToken) {
        player.loadXPFromAPI(function () {
            Logger.debug('[XP] Player data loaded on join for PID=' + player.pID);
            // Broadcast updated player info with perks
            self.broadcastPlayerInfo(player);
        });
    }

    // If target player already has cells, spawn dead cells first
    if (hadCellsBeforeRespawn) {
        Logger.debug('[VANIS] Target player has ' + targetPlayer.cells.length + ' cells, spawning dead cells for respawn');
        this.gameServer.spawnDeadCellsFromPlayer(targetPlayer);

        //   Send delete packets for ALL clientNodes BEFORE clearing
        // Without this, client never learns that old cells should be removed from map (this is also fixed some other issues with rendering somehow)

        if (targetPlayer.clientNodes && targetPlayer.clientNodes.length > 0) {
            var VanisWriter = require('./packet/VanisWriter');
            var writer = new VanisWriter();
            writer.writeUInt8(10); // World update opcode
            writer.writeUInt8(0); // No add/update cells terminator

            // Send all clientNodes as deleted
            for (var i = 0; i < targetPlayer.clientNodes.length; i++) {
                var node = targetPlayer.clientNodes[i];
                if (node && node.nodeId) {
                    writer.writeUInt32(node.nodeId >>> 0);
                }
            }
            writer.writeUInt32(0); // End of deletes
            writer.writeUInt32(0); // No eaten cells

            if (this.socket && this.socket.send) {
                this.socket.send(writer.finalize());
                Logger.debug('[VANIS] Sent delete packets for ' + targetPlayer.clientNodes.length + ' old cells');
            }
        }
        targetPlayer.clientNodes = [];
    }

    // For main player, use the name/skin from client
    // For dual player, joinGame will automatically use dual identity from owner's settings
    var spawnName = name;
    var spawnSkin = skin;

    Logger.info('[VANIS] ✅ Spawning ' + (isSpawningDual ? 'DUAL' : 'MAIN') + ': PID=' + targetPlayer.pID + ' ClientName="' + name + '" HadCells=' + hadCellsBeforeRespawn);

    // Spawn the target player (could be main or dual)
    // Pass hadCellsBeforeRespawn so joinGame knows whether to use near-death spawn
    targetPlayer.joinGame(spawnName, spawnSkin, {
        context: spawnContext,
        allowRespawnWithCells: allowRespawnWithCells,
        hadCellsBeforeRespawn: hadCellsBeforeRespawn
    });

    // Broadcast player info to ALL clients so everyone knows about this player
    this.broadcastPlayerInfo(targetPlayer);

    // IMPORTANT: Always refresh all existing players' info for this client
    // Initial world was sent BEFORE tag was set, so tag isolation was wrong
    // This ensures correct skin visibility based on tag isolation
    Logger.debug('[TAG] Refreshing all player info for correct tag isolation');
    this.refreshAllPlayersForClient();
};

/**
 * Refresh all players' info TO this client - used when tag changes
 * This ensures tag isolation is correctly applied for skins
 */
PacketHandler.prototype.refreshAllPlayersForClient = function () {
    var clients = this.gameServer.clients;
    var thisPlayer = this.socket.playerTracker;
    var refreshCount = 0;

    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || client === this.socket) continue;
        if (!client.playerTracker) continue;

        // Send this player's info to THIS client (with tag isolation applied)
        this.sendVanisPlayerInfo(client.playerTracker);
        refreshCount++;
    }

    Logger.debug('[TAG] Refreshed ' + refreshCount + ' player infos for PID=' + thisPlayer.pID);
};

PacketHandler.prototype.handleVanisSpectate = function (reader) {
    if (this.captchaRequired && !this.socket.captchaVerified) return;
    // Player must not have any cells to spectate
    if (this.socket.playerTracker.cells.length !== 0) return;

    var tracker = this.socket.playerTracker;

    // Check if a specific player ID was provided
    var targetPid = null;
    if (reader.remaining() >= 2) {
        // Client sent a player ID to spectate
        targetPid = reader.readUInt16();
        Logger.debug('[VANIS] Spectate request for player:', targetPid);

        // If clicking same player we're already watching → toggle free roam
        if (tracker.spectateTargetPid === targetPid && tracker.spectate) {
            tracker.freeRoam = !tracker.freeRoam;
            Logger.debug('[VANIS] Toggled free roam mode:', tracker.freeRoam);
            return;
        }
    } else {
        // No target specified - toggle free roam if already spectating
        if (tracker.spectate) {
            tracker.freeRoam = !tracker.freeRoam;
            Logger.debug('[VANIS] Toggled free roam mode (no target):', tracker.freeRoam);
            return;
        }
    }

    // Enable spectate mode and set target
    tracker.spectate = true;
    tracker.freeRoam = false;
    tracker.spectateTargetPid = targetPid;

    Logger.debug('[VANIS] Player', tracker.pID, 'spectating:', targetPid || 'largest player');
};

PacketHandler.prototype.handleVanisPlayerInfo = function (reader) {
    // ========================================
    // SECURITY CHECK: Block if captcha not verified AND no discord bypass
    // ========================================
    if (this.captchaRequired && !this.socket.captchaVerified && !this.socket.discordBypass) {
        Logger.debug('[VANIS] PlayerInfo rejected - captcha not verified');
        return;
    }

    // Parse player info - name and optional discord token
    // Format: [name, discordToken]
    try {
        var parts = [];
        while (reader.remaining() > 0) {
            parts.push(reader.readStringUTF8());
        }

        var name = parts[0] || '';
        var discord = parts[1] || '';

        Logger.debug('[VANIS] Player info received - Name: "' + name + '" Discord: ' + (discord ? 'present' : 'none'));

        var player = this.socket.playerTracker;
        if (!player) return;

        var self = this;

        // ========================================
        // DISCORD BYPASS VALIDATION
        // If using Discord bypass, MUST provide valid Discord token with User ID
        // ========================================
        if (this.socket.discordBypass && !this.socket.discordBypassValidated) {
            if (!discord || discord.length === 0) {
                Logger.info('[CAPTCHA] ❌ Discord bypass used but no Discord token provided - kicking');
                try { this.socket.close(1008, 'Invalid token'); } catch (e) { }
                return;
            }

            // SECURITY: Validate Discord token with API AND extract Discord User ID
            this._validateDiscordBypassWithUserId(discord, function (err, result) {
                if (err || !result || !result.valid) {
                    Logger.info('[CAPTCHA] ❌ Discord bypass rejected - invalid token or missing Discord ID');
                    try { self.socket.close(1008, 'You are not smart enough xD'); } catch (e) { }
                    return;
                }

                // Check bypass security (rate limits, VPN detection, etc.)
                var bypassCheck = self.gameServer.validateDiscordBypass(
                    self.socket.remoteAddress,
                    result.discordUserId,
                    discord
                );

                if (!bypassCheck.allowed) {
                    Logger.warn('[CAPTCHA] ❌ Discord bypass blocked: ' + bypassCheck.reason);
                    try { self.socket.close(1008, 'Too many attempts. Try again later.'); } catch (e) { }
                    return;
                }

                // All good - mark as verified and store Discord User ID
                Logger.info('[CAPTCHA]  Discord bypass verified with Discord ID: ' + result.discordUserId);
                self.socket.discordBypassValidated = true;
                self.socket.discordUserId = result.discordUserId;
                self.socket.captchaVerified = true;
                self.captchaDeadline = null;
                self.socket.discordBypass = false; // Clear flag

                // Record successful bypass for rate limiting
                if (self.gameServer.bypassSecurityManager) {
                    self.gameServer.bypassSecurityManager.recordSuccessfulBypass(
                        self.socket.remoteAddress,
                        result.discordUserId,
                        result.discordName
                    );
                }

                // Continue processing
                self._continuePlayerInfoProcessing(name, discord);
            });
            return; // Wait for async validation
        }

        // Set discord token if provided
        if (discord && discord.length > 0) {
            discord = discord.trim();
            player.discordToken = discord;
            Logger.debug('[VANIS] Discord token set for player');
        }

        // Process name if provided
        var cleanName = '';
        if (name) {
            cleanName = name;
            // Strip skin tags if present
            if (name[0] === '<') {
                var tagEnd = name.indexOf('>');
                if (tagEnd >= 1) {
                    cleanName = name.slice(tagEnd + 1);
                }
            }

            // Truncate if too long
            if (cleanName.length > this.gameServer.config.playerMaxNickLength) {
                cleanName = cleanName.substring(0, this.gameServer.config.playerMaxNickLength);
            }

            // Check bad words
            if (this.gameServer.checkBadWord(cleanName)) {
                cleanName = "Hi there!";
            }
        }

        // Check name lock if name provided (this is not working for some reason)
        if (cleanName && cleanName.length > 0) {
            this.gameServer.checkNameLock(cleanName, discord, function (err, result) {
                var finalName = cleanName;

                if (err) {
                    // API error - allow with original name
                    Logger.debug('[NAME-LOCK] API check failed, allowing: ' + err.message);
                } else if (result && result.locked && !result.isOwner) {
                    // Name is locked by another user - use unnamed
                    Logger.debug('[NAME-LOCK]  Locked name, setting unnamed: ' + cleanName);
                    self.sendVanisChat(null, ' This name is locked by another player!');
                    finalName = '';  // Empty = keep previous or unnamed
                } else if (result && result.locked && result.isOwner) {
                    Logger.debug('[NAME-LOCK]  Player is owner of locked name: ' + cleanName);
                }

                if (finalName) {
                    player._name = finalName;
                }
                self._processPlayerInfoToken(player, discord);
            });
        } else {
            // No name - just process token
            this._processPlayerInfoToken(player, discord);
        }

    } catch (e) {
        Logger.debug('[VANIS] PlayerInfo parse error: ' + e.message);
    }
};

/**
 * Process discord token after name validation
 */
PacketHandler.prototype._processPlayerInfoToken = function (player, discord) {
    var self = this;

    if (discord && discord.length > 0) {
        // Load XP and perks from API, then send "Logged in as" message
        player.loadXPFromAPI(function () {
            Logger.debug('[XP] Player data loaded for PID=' + player.pID);

            // Send "Logged in as" message to the player
            if (player.discordName) {
                Logger.debug('[LOGIN-MSG] Sending "Logged in as ' + player.discordName + '"');
                self.sendVanisChat(null, 'Logged in as "' + player.discordName + '"');
            } else {
                Logger.debug('[LOGIN-MSG] No Discord name available, skipping message');
            }

            // =====================================
            // INSTANT NICKNAME UPDATE TO API
            // Send player's in-game nickname immediately so a!find-user works
            // =====================================
            if (player._name && player.discordToken) {
                self._updateDisplayNameToAPI(player);
            }

            // Broadcast player info to all clients
            self._broadcastPlayerInfoToAll(player);
        });
    } else {
        // No token - just broadcast player info
        this._broadcastPlayerInfoToAll(player);
    }

    Logger.debug('[VANIS] Player info processed for PID=' + player.pID);
};

/**
 * Broadcast player info to all Vanis clients (this is really important)
 */
PacketHandler.prototype._broadcastPlayerInfoToAll = function (player) {
    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client && client.packetHandler && client.packetHandler.isVanis && client.isConnected) {
            if (typeof client.packetHandler.sendVanisPlayerInfo === 'function') {
                client.packetHandler.sendVanisPlayerInfo(player);
            }
        }
    }
};

/**
 * Instantly update player's display name (in-game nickname) to API
 * This makes the nickname immediately searchable via a!find-user
 */
PacketHandler.prototype._updateDisplayNameToAPI = function (player) {
    if (!player || !player.discordToken || !player._name) {
        return;
    }

    // Skip invalid/placeholder names
    var name = player._name;
    if (!name || name === "An unnamed cell" || name === "Hi there!" || name === "Long Name" || name === "Unnamed") {
        return;
    }

    // Strip tags if present
    var cleanName = name;
    if (name[0] === '<') {
        var tagEnd = name.indexOf('>');
        if (tagEnd >= 1) {
            cleanName = name.slice(tagEnd + 1);
        }
    }
    cleanName = cleanName.trim();

    // Limit to 15 characters (UTF-8 safe)
    if (cleanName.length > 15) {
        cleanName = Array.from(cleanName).slice(0, 15).join('');
    }

    if (!cleanName || cleanName.length === 0) {
        return;
    }

    Logger.info('[DISPLAY-NAME] Instant update: "' + cleanName + '" for PID=' + player.pID);

    // Send to API
    var apiUrl = this.gameServer.config.apiServerUrl || process.env.API_SERVER_URL || 'https://aetlis.io/api';
    var url = apiUrl + '/game/bulk-update-display-names';

    var https = require('https');
    var http = require('http');
    var protocol = apiUrl.startsWith('https') ? https : http;

    var postData = JSON.stringify({
        players: [{
            token: player.discordToken,
            displayName: cleanName
        }]
    });

    try {
        var urlObj = new (require('url').URL)(url);
        var options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (apiUrl.startsWith('https') ? 443 : 80),
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        var req = protocol.request(options, function (res) {
            var data = '';
            res.on('data', function (chunk) { data += chunk; });
            res.on('end', function () {
                if (res.statusCode === 200) {
                    Logger.info('[DISPLAY-NAME] ✅ Instant update successful for: ' + cleanName);
                } else {
                    Logger.warn('[DISPLAY-NAME] ❌ API returned: ' + res.statusCode);
                }
            });
        });

        req.on('error', function (error) {
            Logger.warn('[DISPLAY-NAME] ❌ Request error: ' + error.message);
        });

        req.write(postData);
        req.end();
    } catch (err) {
        Logger.warn('[DISPLAY-NAME] ❌ Update error: ' + err.message);
    }
};

PacketHandler.prototype.handleVanisMouse = function (reader) {
    if (reader.remaining() < 8) return;

    // IMPORTANT: Use active player tracker (could be main or dual if dual is active)
    var client = this.getActivePlayerTracker();
    if (!client) return;

    // Use owner's scramble for position calculation
    var owner = this.socket.playerTracker;
    var newMouseX = reader.readInt32() - (owner ? owner.scrambleX : 0);
    var newMouseY = reader.readInt32() - (owner ? owner.scrambleY : 0);

    // Check if linelock is active and mouse moved
    if (client.isLineLocked && client.useMouseProjectionCollision) {
        // Calculate distance moved
        var dx = newMouseX - client.lockedMouse.x;
        var dy = newMouseY - client.lockedMouse.y;
        var distMoved = Math.sqrt(dx * dx + dy * dy);

        // If mouse moved more than threshold, disable projection
        var MOUSE_MOVE_THRESHOLD = 1;

        if (distMoved > MOUSE_MOVE_THRESHOLD) {
            // Disable projection due to mouse movement
            Logger.debug('[PROJECTION]  Disabled for PID=' + client.pID +
                ' reason=MOUSE_MOVED distMoved=' + distMoved.toFixed(2));
            client.useMouseProjectionCollision = false;
            client.isLineLocked = false;
            client.specialLineSplitLockActive = false;
            client.needsProjectionReactivation = true;
            client.projectionActiveUntilTick = 0;

            // Clear root markings
            for (var i = 0; i < client.cells.length; i++) {
                if (client.cells[i]) {
                    client.cells[i].isRootCell = false;
                    client.cells[i].rootCellId = 0;
                }
            }

            // Update mouse position
            client.mouse.x = newMouseX;
            client.mouse.y = newMouseY;
            this._propagateMouseToPartner(client, newMouseX, newMouseY);
            return;
        }

        // Don't update mouse if locked (keep it at locked position)
        this._propagateMouseToPartner(client, newMouseX, newMouseY, { skipLockState: true });
        return;
    }

    // Normal mouse update
    client.mouse.x = newMouseX;
    client.mouse.y = newMouseY;

    // Propagate mouse to partner (dual or owner depending on who's active)
    this._propagateMouseToPartner(client, newMouseX, newMouseY);
};

PacketHandler.prototype.handleVanisSplit = function (reader) {
    // Use active player tracker (main or dual depending on which is active)
    var tracker = this.getActivePlayerTracker();
    if (!tracker) return;

    // Handle minion queue if miQ flag is set
    if (tracker.miQ) {
        tracker.minionSplit = true;
        return;
    }

    // Security check - don't let bots spam splits
    if (this.gameServer.securityManager && !this.gameServer.securityManager.allowAction(this.socket, 'split')) {
        return;
    }

    // Read split amount directly from packet - NO FUCKING MATH.POW!
    // Client sends: 1=single, 2=double, 3=triple, 4=quad, 5=x32, 6=x64, 7=x128, 8=x256
    // Each value IS the number of split iterations to queue
    // 5 iterations = 2^5 = 32 cells, 6 iterations = 2^6 = 64 cells, etc.
    var amount = reader.remaining() ? reader.readUInt8() : 1;

    // Cap at 7 (x128) - we don't need insane split queues
    // Math.pow was converting 6 to 64 splits! again. uhm FUCK MATH POW NIGGA
    amount = Math.max(1, Math.min(amount, 7));

    Logger.debug('[SPLIT] Received split request: amount=' + amount + ' for PID=' + tracker.pID);

    // just add to splitAttempts queue
    tracker.splitAttempts += amount;
    tracker.splitAttemptsTick = this.gameServer.tickCounter;
};

PacketHandler.prototype.handleVanisFeed = function (reader) {
    var active = this.getActivePlayerTracker();
    if (!active) return;

    // Single eject or macro toggle?
    if (reader.remaining() === 0) {
        // Single eject (no data after opcode) - instant
        active.pressW();
    } else {
        // Macro toggle (has 1 byte data)
        var macroState = reader.readUInt8();
        var owner = active.ownerPlayer && active.playerType === 'DUAL_MINION' ? active.ownerPlayer : active;
        this.feedKeyHeld = macroState > 0;
        this.feedKeyOwnerId = owner.pID;

        // Set macro state on active player
        active.ejectMacro = macroState > 0;

        // Handle dual player sync - turn off inactive player's macro if not remembering
        if (!owner.clientWantsRememberEjecting && owner.dualPlayer && owner.dualPlayer !== active) {
            owner.dualPlayer.ejectMacro = false;
        }

        // If turning on macro, clear lastEject for immediate eject
        if (macroState > 0) {
            active.lastEject = null;
        }
    }
};

PacketHandler.prototype.handleVanisChat = function (reader) {
    if (reader.remaining() < 1) return;

    try {
        var message;
        var nullPos = reader.buffer.indexOf(0, reader.offset);

        if (nullPos !== -1 && nullPos < reader.buffer.length) {
            message = reader.readStringUTF8(256);
        } else {
            var start = reader.offset;
            var end = reader.buffer.length;
            message = reader.buffer.toString('utf8', start, end);
            reader.offset = end;
        }

        if (message && message.trim().length > 0) {
            Logger.debug('[VANIS] Chat: "' + message + '"');
            this.gameServer.onChatMessage(this.socket.playerTracker, null, message);
        }
    } catch (err) {
        Logger.debug('[VANIS] Chat read error: ' + err.message);
    }
};

// =====================================
// VANIS SENDERS - Packets going OUT
// =====================================

PacketHandler.prototype.sendVanisInitialWorld = function () {
    var player = this.socket.playerTracker;
    if (!player || !this.socket || !this.socket.isConnected) return;

    var border = this.gameServer.border;
    var gamemode = this.gameServer.config.serverGamemode & 0xFF;

    var writer = new VanisWriter();
    writer.writeUInt8(1); // opcode
    writer.writeUInt8(2); // protocol version
    writer.writeUInt8(gamemode);
    writer.writeUInt16(42069); // instance seed (nice)
    writer.writeUInt16(player.pID & 0xFFFF);
    writer.writeUInt32(border.width >>> 0);
    writer.writeUInt32(border.height >>> 0);

    // Circular map settings - send actual config values
    var isCircle = this.gameServer.config.worldIsCircular ? 1 : 0;
    var radius = this.gameServer.config.worldRadius || 0;
    writer.writeUInt8(isCircle);
    writer.writeUInt32(radius >>> 0);

    // Border kills cells flag (for selfeed mode) - killer border!
    var borderKillsCells = this.gameServer.config.borderKillsCells ? 1 : 0;
    writer.writeUInt8(borderKillsCells);

    this.socket.send(writer.finalize());

    if (isCircle) {
        Logger.info('[VANIS]  Initial world sent - CIRCULAR MAP, Radius: ' + radius);
    } else {
        Logger.info('[VANIS]  Initial world sent - Border: ' + border.width + 'x' + border.height);
    }

    // Send welcome messages - different for tournament mode
    if (this.gameServer.tournamentData && this.gameServer.tournamentData.enabled) {
        // Tournament mode - simplified messages
        this.sendVanisChat(null, 'Aetlis Tournaments 1.0.3');
        this.sendVanisChat(null, 'https://discord.gg/TbjvfWf5bj - Join our Discord for tournaments!');
    } else {
        // Normal mode
        this.sendVanisChat(null, 'Aetlis ' + this.gameServer.version);
        if (this.gameServer.config.serverWelcome1) {
            this.sendVanisChat(null, this.gameServer.config.serverWelcome1);
        }
        if (this.gameServer.config.serverWelcome2) {
            this.sendVanisChat(null, this.gameServer.config.serverWelcome2);
        }
    }

    // Send info for existing players to this new client
    // This ensures new players see all existing players on the server
    var existingPlayerCount = 0;
    for (var i = 0; i < this.gameServer.clients.length; i++) {
        var client = this.gameServer.clients[i];
        if (client && client.playerTracker && client !== this.socket) {
            // Send player info regardless of cell count - client handles rendering
            this.sendVanisPlayerInfo(client.playerTracker);
            existingPlayerCount++;
        }
    }
    Logger.debug('[VANIS] Sent ' + existingPlayerCount + ' existing player infos to new client');

    // If winner countdown is active, notify the new client
    // This ensures newly connected clients see the winner overlay
    if (this.gameServer.winnerCountdownActive && this.gameServer.winnerName) {
        var ticksElapsed = this.gameServer.tickCounter - this.gameServer.winnerCountdownStartTick;
        var secondsElapsed = Math.floor(ticksElapsed / 25);
        var secondsRemaining = Math.max(0, 5 - secondsElapsed);
        this.sendVanisChat(null, "WINNER|" + this.gameServer.winnerName + "|" + secondsRemaining);
        Logger.debug('[VANIS] Sent winner countdown to new client: ' + this.gameServer.winnerName + ' (' + secondsRemaining + 's remaining)');
    }
};

PacketHandler.prototype.sendVanisPing = function () {
    var writer = new VanisWriter();
    writer.writeUInt8(3); // Pong
    this.socket.send(writer.finalize());
};

PacketHandler.prototype.sendVanisWorldUpdate = function (addNodes, updNodes, eatNodes, delNodes) {
    if (!this._initialWorldSent) return;

    var writer = new VanisWriter();
    writer.writeUInt8(10); // World update opcode

    // Helper to write cell data
    var writeCells = function (cells) {
        for (var i = 0; i < cells.length; i++) {
            var cell = cells[i];
            if (!cell) continue;

            // Map cell types
            var vanisType;
            switch (cell.cellType) {
                case 0: vanisType = cell.owner ? 1 : 5; break; // Player
                case 1: vanisType = 4; break; // Food
                case 2: vanisType = 2; break; // Virus
                case 3: vanisType = 3; break; // Ejected
                default: vanisType = 4;
            }

            writer.writeUInt8(vanisType);

            if (vanisType === 1 && cell.owner) {
                writer.writeUInt16(cell.owner.pID & 0xFFFF);
            }

            writer.writeUInt32(cell.nodeId >>> 0);
            writer.writeInt32(Math.floor(cell.position.x));
            writer.writeInt32(Math.floor(cell.position.y));
            writer.writeInt16(Math.floor(cell._size));
        }
    };

    writeCells(addNodes);
    writeCells(updNodes);
    writer.writeUInt8(0); // Terminator

    // Deleted cells
    for (var i = 0; i < delNodes.length; i++) {
        if (delNodes[i]) {
            writer.writeUInt32(delNodes[i].nodeId >>> 0);
        }
    }
    writer.writeUInt32(0);

    // Eaten cells
    for (var i = 0; i < eatNodes.length; i++) {
        var cell = eatNodes[i];
        if (cell && cell.nodeId) {
            writer.writeUInt32(cell.nodeId >>> 0);
            writer.writeUInt32((cell.killedBy && cell.killedBy.nodeId) ? (cell.killedBy.nodeId >>> 0) : 0);
        }
    }
    writer.writeUInt32(0);

    var buffer = writer.finalize();

    // Profiler tracking - Vanis bandwidth
    var dp = this.gameServer.detailedProfiler;
    if (dp) {
        dp.bytesSent += buffer.length;
        dp.packetsSent++;
        dp.vanisWorldUpdates = (dp.vanisWorldUpdates || 0) + 1;
    }

    this.socket.send(buffer);
};

PacketHandler.prototype.sendVanisPlayerInfo = function (player) {
    if (!this._initialWorldSent) return;

    var writer = new VanisWriter();
    writer.writeUInt8(15); // Player info opcode
    writer.writeUInt16(player.pID & 0xFFFF);

    // Check if viewer can see this player's skin (tag isolation)
    // Only skin is hidden by tag isolation - name color is ALWAYS visible
    var viewer = this.socket.playerTracker;
    var canSeeSkin = !viewer || !viewer.canSeePlayerByTag || viewer.canSeePlayerByTag(player);

    // TOURNAMENT MODE: Hide enemy team skins (cells still visible, just no skin image)
    var tm = this.gameServer.tournamentManager;
    if (canSeeSkin && tm && tm.shouldHideEnemyInfo(viewer, player)) {
        canSeeSkin = false;
    }

    var nameToSend = player._name || "";
    var skinToSend = canSeeSkin ? (player._skin || "") : "";

    writer.writeStringUTF8(nameToSend);
    writer.writeStringUTF8(skinToSend);

    // Send name color - ALWAYS visible regardless of tag 

    var nameColorToSend = "";
    if (player.nameColorEnabled && player.nameColor) {
        nameColorToSend = player.nameColor;
    }
    writer.writeStringUTF8(nameColorToSend);

    // Send badge ID - also always visible
    writer.writeUInt8(player.badgeId || 0);

    // Send bot flag - client uses this to apply pale color tint to bot cells
    writer.writeUInt8(player.isBot ? 1 : 0);

    // Send player cell color (RGB) - for bot cell colors
    // Client reads these bytes to render bots with correct colors
    var cellColor = player.color || { r: 255, g: 255, b: 255 };
    writer.writeUInt8(cellColor.r & 0xFF);
    writer.writeUInt8(cellColor.g & 0xFF);
    writer.writeUInt8(cellColor.b & 0xFF);

    this.socket.send(writer.finalize());
};

PacketHandler.prototype.sendVanisLeaderboard = function () {
    if (!this._initialWorldSent) return;

    var player = this.socket.playerTracker;
    if (!player || !player.gameServer) return;

    var lbType = player.gameServer.leaderboardType;
    var lbList = player.gameServer.leaderboard;

    if (lbType < 0 || !lbList || lbList.length === 0) return;

    // Use legacy packet for now (works fine)
    var packet = new Packet.UpdateLeaderboard(player, lbList, lbType);
    var buffer = packet.build(this.protocol);
    if (buffer) {
        // Profiler tracking
        var dp = this.gameServer.detailedProfiler;
        if (dp) {
            dp.bytesSent += buffer.length;
            dp.packetsSent++;
            dp.leaderboardSends++;
        }
        this.socket.send(buffer);
    }
};

PacketHandler.prototype.sendVanisMinimap = function () {
    if (!this._initialWorldSent) return;

    var player = this.socket.playerTracker;
    if (!player) return;

    // TOURNAMENT MODE: Send empty minimap to spectators 
    if (player._tournamentSpawnBlocked) {
        var emptyWriter = new VanisWriter();
        emptyWriter.writeUInt8(12); // Minimap opcode
        // No player data = empty minimap
        this.socket.send(emptyWriter.finalize());
        return;
    }

    var writer = new VanisWriter();
    writer.writeUInt8(12); // Minimap opcode

    var clients = this.gameServer.clients;
    var border = this.gameServer.border;

    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var pt = client.playerTracker;
        if (pt.cells.length === 0) continue;

        // Skip bots from minimap
        if (client.isBot || pt.isBot) continue;

        // Tag isolation - skip players that can't be seen
        if (player && typeof player.canSeePlayerByTag === 'function' && !player.canSeePlayerByTag(pt)) {
            continue;
        }

        // TOURNAMENT MODE: Hide enemy team positions from minimap
        var tm = this.gameServer.tournamentManager;
        if (tm && tm.shouldHideEnemyInfo(player, pt)) {
            continue; // Skip enemy team members during active tournament round
        }

        // Calculate center of mass
        var comX = 0, comY = 0, totalSize = 0;
        for (var j = 0; j < pt.cells.length; j++) {
            var cell = pt.cells[j];
            comX += cell.position.x * cell._size;
            comY += cell.position.y * cell._size;
            totalSize += cell._size;
        }

        if (totalSize > 0) {
            comX /= totalSize;
            comY /= totalSize;

            var normX = (comX - border.minx) / border.width;
            var normY = (comY - border.miny) / border.height;

            var mapX = Math.max(0, Math.min(255, Math.floor(normX * 255)));
            var mapY = Math.max(0, Math.min(255, Math.floor(normY * 255)));

            writer.writeUInt16(pt.pID & 0xFFFF);
            writer.writeUInt8(mapX);
            writer.writeUInt8(mapY);
        }
    }
    writer.writeUInt16(0); // Terminator

    var buffer = writer.finalize();

    // Profiler tracking
    var dp = this.gameServer.detailedProfiler;
    if (dp) {
        dp.bytesSent += buffer.length;
        dp.packetsSent++;
    }

    this.socket.send(buffer);
};
// this is working weirdly
PacketHandler.prototype.sendVanisCameraPosition = function (x, y) {
    if (!this._initialWorldSent) return;

    var writer = new VanisWriter();
    writer.writeUInt8(17); // Camera position opcode
    writer.writeInt32(Math.floor(x));
    writer.writeInt32(Math.floor(y));
    this.socket.send(writer.finalize());
};

PacketHandler.prototype.sendVanisOwnedCellCount = function () {
    if (!this._initialWorldSent) return;

    var player = this.socket.playerTracker;
    if (!player) return;

    var writer = new VanisWriter();
    writer.writeUInt8(21); // Owned cell count opcode
    writer.writeUInt16(player.cells.length & 0xFFFF);
    this.socket.send(writer.finalize());
};

// XP Update - Opcode 19
// Format: uint8 opcode, uint8 levelUp, uint32 totalXP, [if levelUp] uint16 newLevel
PacketHandler.prototype.sendVanisXPUpdate = function (levelUp, totalXP, currentLevel) {
    if (!this._initialWorldSent) return;

    var writer = new VanisWriter();
    writer.writeUInt8(19); // XP update opcode
    writer.writeUInt8(levelUp ? 1 : 0); // Level up flag
    writer.writeUInt32(totalXP >>> 0); // Total XP (unsigned 32-bit)

    if (levelUp) {
        writer.writeUInt16(currentLevel & 0xFFFF); // New level
    }

    this.socket.send(writer.finalize());
};

// Force Spectate - Opcode 50
// Tournament mode: tells client "you're not signed up, spectator only buddy"
PacketHandler.prototype.sendVanisForceSpectate = function () {
    if (!this._initialWorldSent) return;
    if (!this.socket || !this.socket.isConnected) return;

    var writer = new VanisWriter();
    writer.writeUInt8(50); // Force spectate opcode
    this.socket.send(writer.finalize());

    Logger.debug('[TOURNAMENT]  Sent ForceSpectate packet (opcode 50)');
};

// Allow Play - Opcode 51
// Tournament mode: tells registered player "you're good to go, play "
PacketHandler.prototype.sendVanisAllowPlay = function () {
    if (!this._initialWorldSent) return;
    if (!this.socket || !this.socket.isConnected) return;

    var writer = new VanisWriter();
    writer.writeUInt8(51); // Allow play opcode
    this.socket.send(writer.finalize());

    Logger.debug('[TOURNAMENT] 📤 Sent AllowPlay packet (opcode 51)');
};

// ========================================
// TOURNAMENT SYSTEM PACKETS

// ========================================

// Tournament State - Opcode 52
// Sends full tournament state to client for UI rendering
PacketHandler.prototype.sendTournamentState = function (state) {
    if (!this._initialWorldSent) return;
    if (!this.socket || !this.socket.isConnected) return;
    if (!state) return;

    var writer = new VanisWriter();
    writer.writeUInt8(52); // Tournament state opcode

    // Pack the state into a JSON string - client will parse it
    // Not the most efficient but flexible for complex data (hopefully)
    var stateJson = JSON.stringify(state);
    var stateBuffer = Buffer.from(stateJson, 'utf8');

    writer.writeUInt16(stateBuffer.length);
    writer.writeBuffer(stateBuffer);

    this.socket.send(writer.finalize());
};

// Tournament Round End - Opcode 53
// congrats
PacketHandler.prototype.sendTournamentRoundEnd = function (data) {
    if (!this._initialWorldSent) return;
    if (!this.socket || !this.socket.isConnected) return;
    if (!data) return;

    var writer = new VanisWriter();
    writer.writeUInt8(53); // Round end opcode

    var dataJson = JSON.stringify(data);
    var dataBuffer = Buffer.from(dataJson, 'utf8');

    writer.writeUInt16(dataBuffer.length);
    writer.writeBuffer(dataBuffer);

    this.socket.send(writer.finalize());
};

// Tournament Match End - Opcode 54
// congrats
PacketHandler.prototype.sendTournamentMatchEnd = function (data) {
    if (!this._initialWorldSent) return;
    if (!this.socket || !this.socket.isConnected) return;
    if (!data) return;

    var writer = new VanisWriter();
    writer.writeUInt8(54); // Match end opcode

    var dataJson = JSON.stringify(data);
    var dataBuffer = Buffer.from(dataJson, 'utf8');

    writer.writeUInt16(dataBuffer.length);
    writer.writeBuffer(dataBuffer);

    this.socket.send(writer.finalize());
};

// Tournament Respawn Cooldown - Opcode 55
// Sent when player tries to respawn during cooldown
PacketHandler.prototype.sendRespawnCooldown = function (remainingSeconds, isDual) {
    if (!this._initialWorldSent) return;
    if (!this.socket || !this.socket.isConnected) return;

    var writer = new VanisWriter();
    writer.writeUInt8(55); // Respawn cooldown opcode
    writer.writeFloat32(remainingSeconds); // Remaining time in seconds
    writer.writeUInt8(isDual ? 1 : 0); // Is this for dual player?

    this.socket.send(writer.finalize());

    Logger.info('[TOURNAMENT] Sent respawn cooldown: ' + remainingSeconds.toFixed(1) + 's (isDual: ' + !!isDual + ')');
};

// Handle Tournament Command from Client - called from handleVanisMessage
PacketHandler.prototype.handleTournamentCommand = function (reader) {
    var player = this.socket.playerTracker;
    if (!player) return;

    try {
        // Read command length and data using readBytes (not readBuffer!)
        var cmdLength = reader.readUInt16();
        var cmdBuffer = reader.readBytes(cmdLength);
        var cmdJson = cmdBuffer.toString('utf8');

        var cmdData = JSON.parse(cmdJson);
        var command = cmdData.command;
        var data = cmdData.data || {};

        Logger.info('[TOURNAMENT] 📥 Referee command: ' + command);

        // Delegate to tournament manager
        if (this.gameServer.tournamentManager) {
            this.gameServer.tournamentManager.handleRefereeCommand(player, command, data);
        }
    } catch (err) {
        Logger.warn('[TOURNAMENT] Failed to parse tournament command: ' + err.message);
    }
};

PacketHandler.prototype.sendVanisChat = function (from, message) {
    if (!this.socket || !this.socket.isConnected) return;

    var writer = new VanisWriter();
    writer.writeUInt8(13); // Chat opcode
    writer.writeUInt16(from ? (from.pID & 0xFFFF) : 0);

    var msgBuffer = Buffer.from(message || '', 'utf8');
    writer.writeBuffer(msgBuffer);
    writer.writeUInt16(0); // Terminator

    this.socket.send(writer.finalize());
};

PacketHandler.prototype.broadcastPlayerInfo = function (player) {
    if (!player) return;
    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client && client.packetHandler && client.packetHandler.isVanis && client.isConnected) {
            // Safety check - ensure sendVanisPlayerInfo exists
            if (typeof client.packetHandler.sendVanisPlayerInfo === 'function') {
                client.packetHandler.sendVanisPlayerInfo(player);
            }
        }
    }
    Logger.debug('[BROADCAST] Player info sent for PID=' + player.pID + ' Name=' + (player._name || ''));
};

// =====================================
// LEGACY PROTOCOL - ignore this i was trying something
// =====================================

PacketHandler.prototype.handshake_onProtocol = function (message) {
    if (message.length !== 5) return;
    this.handshakeProtocol = message[1] | (message[2] << 8) | (message[3] << 16) | (message[4] << 24);
    if (this.handshakeProtocol < 1 || this.handshakeProtocol > 11) {
        this.socket.close(1002, "Not supported protocol");
        return;
    }
    this.handler = {
        255: this.handshake_onKey.bind(this),
    };
};

PacketHandler.prototype.handshake_onKey = function (message) {
    if (message.length !== 5) return;
    this.handshakeKey = message[1] | (message[2] << 8) | (message[3] << 16) | (message[4] << 24);
    if (this.handshakeProtocol > 6 && this.handshakeKey !== 0) {
        this.socket.close(1002, "Not supported protocol");
        return;
    }
    this.handshake_onCompleted(this.handshakeProtocol, this.handshakeKey);
};

PacketHandler.prototype.handshake_onCompleted = function (protocol, key) {
    this.handler = {
        0: this.message_onJoin.bind(this),
        1: this.message_onSpectate.bind(this),
        16: this.message_onMouse.bind(this),
        17: this.message_onKeySpace.bind(this),
        18: this.message_onKeyQ.bind(this),
        21: this.message_onKeyW.bind(this),
        99: this.message_onChat.bind(this),
        254: this.message_onStat.bind(this),
    };
    this.protocol = protocol;

    this.socket.sendPacket(new Packet.ClearAll());
    this.socket.sendPacket(new Packet.SetBorder(this.socket.playerTracker, this.gameServer.border, this.gameServer.config.serverGamemode, "Aetlis " + this.gameServer.version));

    // Send welcome messages - different for tournament mode
    if (this.gameServer.tournamentData && this.gameServer.tournamentData.enabled) {
        // Tournament mode - simplified messages
        this.gameServer.sendChatMessage(null, this.socket.playerTracker, "Aetlis Tournaments 1.0.3");
        this.gameServer.sendChatMessage(null, this.socket.playerTracker, "https://discord.gg/TbjvfWf5bj - Join our Discord for tournaments!");
    } else {
        // Normal mode
        this.gameServer.sendChatMessage(null, this.socket.playerTracker, "Aetlis " + this.gameServer.version);
        if (this.gameServer.config.serverWelcome1)
            this.gameServer.sendChatMessage(null, this.socket.playerTracker, this.gameServer.config.serverWelcome1);
        if (this.gameServer.config.serverWelcome2)
            this.gameServer.sendChatMessage(null, this.socket.playerTracker, this.gameServer.config.serverWelcome2);
    }
};

PacketHandler.prototype.message_onJoin = function (message) {
    var tick = this.gameServer.tickCounter;
    var dt = tick - this.lastJoinTick;
    this.lastJoinTick = tick;
    if (dt < 25 || this.socket.playerTracker.cells.length !== 0) return;

    var reader = new BinaryReader(message);
    reader.skipBytes(1);
    var text = null;
    if (this.protocol < 6)
        text = reader.readStringZeroUnicode();
    else
        text = reader.readStringZeroUtf8();
    this.setNickname(text);
};

PacketHandler.prototype.message_onSpectate = function (message) {
    if (this.socket.playerTracker.cells.length !== 0) return;

    var tracker = this.socket.playerTracker;
    var targetPid = null;

    // Check if a specific player ID was provided (3 bytes: opcode + 2-byte PID)
    if (message.length === 3) {
        var reader = new BinaryReader(message);
        reader.skipBytes(1); // Skip opcode
        targetPid = reader.readUInt16();

        // If clicking same player we're already watching → toggle free roam
        if (tracker.spectateTargetPid === targetPid && tracker.spectate) {
            tracker.freeRoam = !tracker.freeRoam;
            return;
        }
    } else if (message.length === 1) {
        // No target - toggle free roam if already spectating
        if (tracker.spectate) {
            tracker.freeRoam = !tracker.freeRoam;
            return;
        }
    } else {
        return; // Invalid packet size
    }

    // Enable spectate mode and set target
    tracker.spectate = true;
    tracker.freeRoam = false;
    tracker.spectateTargetPid = targetPid;
};

PacketHandler.prototype.message_onMouse = function (message) {
    if (message.length !== 13 && message.length !== 9 && message.length !== 21) return;
    this.mouseData = Buffer.concat([message]);
};

PacketHandler.prototype.message_onKeySpace = function (message) {
    if (this.socket.playerTracker.miQ)
        this.socket.playerTracker.minionSplit = true;
    else
        this.pressSpace = true;
};

PacketHandler.prototype.message_onKeyQ = function (message) {
    if (message.length !== 1) return;
    var tick = this.gameServer.tickCounter;
    var dt = tick - this.lastQTick;
    if (dt < this.gameServer.config.ejectCooldown) return;
    this.lastQTick = tick;
    this.pressQ = true;
};

PacketHandler.prototype.message_onKeyW = function (message) {
    if (message.length !== 1) return;
    var tick = this.gameServer.tickCounter;
    var dt = tick - this.lastWTick;
    if (dt < this.gameServer.config.ejectCooldown) return;
    this.lastWTick = tick;
    this.pressW = true;
};

PacketHandler.prototype.message_onChat = function (message) {
    if (message.length < 3) return;
    var tick = this.gameServer.tickCounter;
    var dt = tick - this.lastChatTick;
    this.lastChatTick = tick;
    if (dt < 50) return;

    var flags = message[1];
    var rvLength = (flags & 2 ? 4 : 0) + (flags & 4 ? 8 : 0) + (flags & 8 ? 16 : 0);
    if (message.length < 3 + rvLength) return;

    var reader = new BinaryReader(message);
    reader.skipBytes(2 + rvLength);
    var text = null;
    if (this.protocol < 6)
        text = reader.readStringZeroUnicode();
    else
        text = reader.readStringZeroUtf8();
    this.gameServer.onChatMessage(this.socket.playerTracker, null, text);
};

PacketHandler.prototype.message_onStat = function (message) {
    if (message.length !== 1) return;
    var tick = this.gameServer.tickCounter;
    var dt = tick - this.lastStatTick;
    this.lastStatTick = tick;
    if (dt < 25) return;
    this.socket.sendPacket(new Packet.ServerStat(this.socket.playerTracker));
};

// =====================================
// PROCESS - Called every tick
// =====================================

PacketHandler.prototype.processMouse = function () {
    if (this.mouseData == null) return;
    var client = this.socket.playerTracker;
    var reader = new BinaryReader(this.mouseData);
    reader.skipBytes(1);
    if (this.mouseData.length === 13) {
        client.mouse.x = reader.readInt32() - client.scrambleX;
        client.mouse.y = reader.readInt32() - client.scrambleY;
    } else if (this.mouseData.length === 9) {
        client.mouse.x = reader.readInt16() - client.scrambleX;
        client.mouse.y = reader.readInt16() - client.scrambleY;
    } else if (this.mouseData.length === 21) {
        var x = reader.readDouble() - client.scrambleX;
        var y = reader.readDouble() - client.scrambleY;
        if (!isNaN(x) && !isNaN(y)) {
            client.mouse.x = x;
            client.mouse.y = y;
        }
    }
    this.mouseData = null;
};

PacketHandler.prototype.process = function () {
    // Enforce captcha deadline
    if (this.captchaRequired && !this.socket.captchaVerified &&
        !this.socket.isBot && this.captchaDeadline &&
        Date.now() > this.captchaDeadline) {
        Logger.info('[CAPTCHA]  Deadline exceeded - kicking ' + (this.socket.remoteAddress || 'unknown'));
        this._closeSocket(1008, 'Captcha timeout');
        return; // Don't process anything for kicked players
    }

    this.processMouse();

    // Get active tracker (for dual player support)
    var tracker = this.getActivePlayerTracker();
    if (!tracker) tracker = this.socket.playerTracker;
    if (!tracker) return;

    if (this.pressSpace) {
        tracker.pressSpace();
        this.pressSpace = false;
    }
    if (this.pressW) {
        tracker.pressW();
        this.pressW = false;
    }
    if (this.pressQ) {
        tracker.pressQ();
        this.pressQ = false;
    }

    // Handle minion control flags
    if (tracker.minionSplit) tracker.minionSplit = false;
    if (tracker.minionEject) tracker.minionEject = false;

    // Handle eject macro for Vanis clients
    if (this.socket.playerTracker.ejectMacro && this.socket.playerTracker.cells.length > 0) {
        this.socket.playerTracker.pressW();
    }
};

PacketHandler.prototype.getRandomSkin = function () {
    var randomSkins = [];
    var fs = require("fs");
    if (fs.existsSync("../src/randomskins.txt")) {
        randomSkins = fs.readFileSync("../src/randomskins.txt", "utf8").split(/[\r\n]+/).filter(function (x) {
            return x != '';
        });
    }
    if (randomSkins.length > 0) {
        var index = (randomSkins.length * Math.random()) >>> 0;
        return randomSkins[index];
    }
    return '';
};

PacketHandler.prototype.setNickname = function (text) {
    var name = "",
        skin = null;
    if (text != null && text.length > 0) {
        var skinName = null,
            userName = text,
            n = -1;
        if (text[0] == '<' && (n = text.indexOf('>', 1)) >= 1) {
            var inner = text.slice(1, n);
            if (n > 1)
                skinName = (inner == "r") ? "%" + this.getRandomSkin() : "%" + inner;
            else
                skinName = "";
            userName = text.slice(n + 1);
        }
        skin = skinName;
        name = userName;
    }

    if (name.length > this.gameServer.config.playerMaxNickLength)
        name = name.substring(0, this.gameServer.config.playerMaxNickLength);

    if (this.gameServer.checkBadWord(name)) {
        skin = null;
        name = "Hi there!";
    }

    this.socket.playerTracker.joinGame(name, skin);
};

// =====================================
// MOUSE PROJECTION / LINELOCK SYSTEM
// 
// =====================================

PacketHandler.prototype.handleVanisLinelock = function (reader) {
    // Use active player tracker (main or dual if dual is active)
    var player = this.getActivePlayerTracker();
    if (!player) return;
    this.executeLinelock(player);
};

PacketHandler.prototype.executeLinelock = function (player) {
    if (!player) return;

    // Toggle generic linelock
    player.isLineLocked = !player.isLineLocked;

    // Reset diagonal suppression when linelock is toggled
    var lastDiagTick = player.lastDiagonalSplitTick || 0;
    var ticksSinceDiag = this.gameServer.tickCounter - lastDiagTick;

    if (ticksSinceDiag < 2) {
        // Keep diagonal snap disabled if diagonal packet was recent
    } else {
        player.diagonalSnapDisabled = false;
    }

    Logger.debug('[LINELOCK] Toggled for PID=' + player.pID + ' state=' + player.isLineLocked);

    if (player.isLineLocked) {
        // Apply snapping first
        this._maybeSnapMouseForLineLock(player);

        // Lock current mouse position (after snapping)
        player.lockedMouse.x = player.mouse.x;
        player.lockedMouse.y = player.mouse.y;

        // Enable projection
        player.needsProjectionReactivation = false;

        // Set projection window duration (1 second = 25 ticks @ 40ms per tick)
        var projectionDurationTicks = this.gameServer.config.tickDelay ?
            Math.floor(1000 / this.gameServer.config.tickDelay) : 25;
        player.projectionActiveUntilTick = this.gameServer.tickCounter + projectionDurationTicks;
        player.projectionActivatedTick = this.gameServer.tickCounter;
        player.useMouseProjectionCollision = true;

        Logger.debug('[PROJECTION]  Enabled for PID=' + player.pID +
            ' projectionActiveUntilTick=' + player.projectionActiveUntilTick +
            ' lockedMouse=(' + player.lockedMouse.x.toFixed(1) + ',' + player.lockedMouse.y.toFixed(1) + ')');

        // Assign root cell for projection
        if (player.assignProjectionRootCell && !player.assignProjectionRootCell('linelockToggleOn')) {
            Logger.debug('[PROJECTION]  Failed to assign root cell - forcing release');
            player.forceReleaseLineLock('rootAssignmentFailed');
        }
    } else {
        // Disable projection
        Logger.debug('[PROJECTION]  Disabled for PID=' + player.pID + ' reason=LINELOCK_TOGGLE_OFF');
        player.needsProjectionReactivation = true;
        player.projectionActiveUntilTick = 0;
        player.useMouseProjectionCollision = false;

        // Clear root markings
        for (var i = 0; i < player.cells.length; i++) {
            if (player.cells[i]) {
                player.cells[i].isRootCell = false;
                player.cells[i].rootCellId = 0;
            }
        }
    }
};

PacketHandler.prototype.handleVanisSpecialLinelock = function (reader) {
    // Use active player tracker (main or dual if dual is active)
    var player = this.getActivePlayerTracker();
    if (!player) return;
    this.executeSpecialLinelock(player);
};

PacketHandler.prototype.executeSpecialLinelock = function (player) {
    if (!player) return;

    // Toggle special linesplit lock
    player.specialLineSplitLockActive = !player.specialLineSplitLockActive;
    Logger.debug('[LINELOCK] Special toggled for PID=' + player.pID + ' state=' + player.specialLineSplitLockActive);

    // If turning off special lock, also disable projection
    if (!player.specialLineSplitLockActive) {
        Logger.debug('[PROJECTION] ❌ Disabled for PID=' + player.pID + ' reason=SPECIAL_LINELOCK_TOGGLE_OFF');
        player.useMouseProjectionCollision = false;
        player.isLineLocked = false;
        player.needsProjectionReactivation = true;
        player.projectionActiveUntilTick = 0;

        // Clear root markings
        for (var i = 0; i < player.cells.length; i++) {
            if (player.cells[i]) {
                player.cells[i].isRootCell = false;
                player.cells[i].rootCellId = 0;
            }
        }
    } else {
        // Enable projection when special lock is turned on
        player.lockedMouse.x = player.mouse.x;
        player.lockedMouse.y = player.mouse.y;
        player.isLineLocked = true;
        player.needsProjectionReactivation = false;

        // Set projection window duration (2 seconds for special linelock)
        var projectionDurationTicks = this.gameServer.config.tickDelay ?
            Math.floor(2000 / this.gameServer.config.tickDelay) : 50;
        player.projectionActiveUntilTick = this.gameServer.tickCounter + projectionDurationTicks;
        player.useMouseProjectionCollision = true;

        Logger.debug('[PROJECTION] ✅ Enabled for PID=' + player.pID +
            ' reason=SPECIAL_LINELOCK_ON' +
            ' duration=' + projectionDurationTicks);

        // Assign root cell
        if (player.assignProjectionRootCell) {
            player.assignProjectionRootCell('specialLinelockOn');
        }
    }
};

PacketHandler.prototype.handleVanisDiagonalLinesplitNotice = function () {
    // Use active player tracker (main or dual if dual is active)
    var player = this.getActivePlayerTracker();
    if (!player) return;
    this.executeDiagonalLinesplitNotice(player);
};

PacketHandler.prototype.executeDiagonalLinesplitNotice = function (player) {
    if (!player) return;

    Logger.debug('[DIAGONAL-LINESPLIT] Executing for PID=' + player.pID);

    // STATE-BASED LOGIC: Explicitly disable snapping
    player.diagonalSnapDisabled = true;
    player.lastDiagonalSplitTick = this.gameServer.tickCounter;
};

PacketHandler.prototype._maybeSnapMouseForLineLock = function (player) {
    if (!player || !player.centerPos) return;

    // Check if snapping is disabled by diagonal split
    if (player.diagonalSnapDisabled) {
        Logger.debug('[SNAP-DEBUG] Snapping disabled due to diagonal split');
        return;
    }

    // Always ensure we have a root cell for snap calculation
    if (player.cells.length >= 1) {
        var currentRoot = player._getProjectionRootCell ? player._getProjectionRootCell() : null;
        if (!currentRoot || currentRoot.isRemoved) {
            if (player.assignProjectionRootCell) {
                player.assignProjectionRootCell('snapUpdate');
            }
        }
    }

    // Get root cell - use its position for snap calculation
    var rootCell = player._getProjectionRootCell ? player._getProjectionRootCell() : null;

    // CRITICAL: Use ROOT CELL position ONLY - not centerPos (average of all cells)
    var centerX, centerY;
    if (rootCell) {
        centerX = rootCell.position.x;
        centerY = rootCell.position.y;
        Logger.debug('[SNAP] Using rootCell position: (' + centerX.toFixed(1) + ', ' + centerY.toFixed(1) + ') nodeId=' + rootCell.nodeId);
    } else if (player.cells.length === 1 && player.cells[0]) {
        // Fallback: use single cell position directly
        centerX = player.cells[0].position.x;
        centerY = player.cells[0].position.y;
        Logger.debug('[SNAP] Using single cell position: (' + centerX.toFixed(1) + ', ' + centerY.toFixed(1) + ')');
    } else {
        // This should NOT happen - means no cells
        Logger.debug('[SNAP] WARNING: No root cell and no cells! Using centerPos');
        centerX = player.centerPos.x;
        centerY = player.centerPos.y;
    }

    // Log centerPos for comparison (should be different if 2+ cells)
    if (player.cells.length > 1) {
        Logger.debug('[SNAP] centerPos (average): (' + player.centerPos.x.toFixed(1) + ', ' + player.centerPos.y.toFixed(1) + ') - NOT used!');
    }

    var dx = player.mouse.x - centerX;
    var dy = player.mouse.y - centerY;
    var length = Math.sqrt(dx * dx + dy * dy);

    Logger.debug('[SNAP] Mouse: (' + player.mouse.x.toFixed(1) + ', ' + player.mouse.y.toFixed(1) + ') dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1) + ' length=' + length.toFixed(1));

    if (!length || length < 1) {
        return;
    }

    var dirX = dx / length;
    var dirY = dy / length;

    // 8 directions: 4 cardinal + 4 diagonal
    var sqrt2_inv = 1.0 / Math.sqrt(2);
    var canonical = [
        { x: 1.0, y: 0.0 },           // East (Sağ)
        { x: -1.0, y: 0.0 },          // West (Sol)
        { x: 0.0, y: 1.0 },           // South (Aşağı)
        { x: 0.0, y: -1.0 },          // North (Yukarı)
        { x: sqrt2_inv, y: sqrt2_inv },     // South-East (Sağ-Aşağı)
        { x: -sqrt2_inv, y: sqrt2_inv },    // South-West (Sol-Aşağı)
        { x: sqrt2_inv, y: -sqrt2_inv },    // North-East (Sağ-Yukarı)
        { x: -sqrt2_inv, y: -sqrt2_inv }    // North-West (Sol-Yukarı)
    ];

    var bestDot = -2;
    var bestDir = null;
    for (var i = 0; i < canonical.length; i++) {
        var d = canonical[i];
        var dot = dirX * d.x + dirY * d.y;
        if (dot > bestDot) {
            bestDot = dot;
            bestDir = d;
        }
    }

    if (bestDir) {
        var snapX = centerX + bestDir.x * length;
        var snapY = centerY + bestDir.y * length;

        Logger.debug('[SNAP-DEBUG] ✅ SNAPPING to: (' + snapX.toFixed(2) + ', ' + snapY.toFixed(2) + ')');

        player.mouse.x = snapX;
        player.mouse.y = snapY;

        // CRITICAL: Update lockedMouse to prevent false mouse movement detection
        player.lockedMouse.x = snapX;
        player.lockedMouse.y = snapY;
    }
};

// =====================================
// DUAL PLAYER SYSTEM HANDLERS
// Multibox magic - because two blobs are better than one
// =====================================

// Get the currently active player tracker (main or dual if active)
PacketHandler.prototype.getActivePlayerTracker = function () {
    var tracker = this.socket.playerTracker;
    if (!tracker) return null;

    // If dual mode is active, return the dual player
    if (tracker.isDualActive && tracker.dualPlayer) {
        return tracker.dualPlayer;
    }
    return tracker;
};

// Get the player that should spawn (handles dual respawning)
// This is the most critical function for dual player spawn targeting
// The logic must be CRYSTAL CLEAR about which player to spawn
PacketHandler.prototype.getSpawnTargetPlayer = function () {
    var owner = this.socket.playerTracker;
    if (!owner) return null;

    // Log current state for debugging
    Logger.debug('[SPAWN-TARGET] Determining spawn target:' +
        ' ownerPID=' + owner.pID +
        ' isDualActive=' + owner.isDualActive +
        ' ownerCells=' + owner.cells.length +
        ' hasDual=' + !!owner.dualPlayer +
        ' dualCells=' + (owner.dualPlayer ? owner.dualPlayer.cells.length : 0));

    // PRIMARY RULE: isDualActive determines which player we're controlling
    // If isDualActive=true → we want to spawn/control dual
    // If isDualActive=false → we want to spawn/control main

    if (owner.isDualActive && owner.dualPlayer) {
        // User is controlling dual - spawn the dual player
        Logger.info('[SPAWN-TARGET] → DUAL (isDualActive=true) PID=' + owner.dualPlayer.pID);
        return owner.dualPlayer;
    }

    // User is controlling main (isDualActive=false) - spawn the main player
    // Even if main is dead and dual is alive, we want to respawn MAIN
    Logger.info('[SPAWN-TARGET] → MAIN (isDualActive=false) PID=' + owner.pID);
    return owner;
};

// Handle switch multibox request (toggle active player)
PacketHandler.prototype.handleSwitchMultibox = function () {
    Logger.debug('[DUAL] handleSwitchMultibox called (opcode 23)');

    // Block during tournament pause/freeze
    // Tournament mode: block switch only during PAUSE, allow during FROZEN (reset/prep time)
    var tm = this.gameServer.tournamentManager;
    if (tm && tm.isActive && tm.isPaused) {
        Logger.debug('[DUAL] Switch request rejected - tournament paused');
        return;
    }

    // Check if dual is disabled in config
    if (this.gameServer.config.dualDisabled) {
        Logger.debug('[DUAL] Switch request rejected - dual is disabled in this game mode');
        if (this.socket.playerTracker) {
            this.gameServer.sendChatMessage(null, this.socket.playerTracker, "In this mode dual is disabled");
        }
        return;
    }

    var owner = this.socket.playerTracker;
    if (!owner) return;

    if (owner.minionControlActive) {
        Logger.debug('[DUAL] Switch request ignored - minion control mode is active for PID=' + owner.pID);
        return;
    }

    // Get both players explicitly - no confusion allowed
    var mainPlayer = owner;
    var dualPlayer = owner.dualPlayer;

    // What are we currently controlling?
    var wasControllingDual = owner.isDualActive;

    // Log current state for debugging this nightmare
    Logger.debug('[DUAL-SWITCH] 📊 Before switch: controlling=' + (wasControllingDual ? 'DUAL' : 'MAIN') +
        ' mainCells=' + mainPlayer.cells.length +
        ' dualCells=' + (dualPlayer ? dualPlayer.cells.length : 'N/A'));

    // Always switch to the other player
    var newActive = !wasControllingDual;
    owner.setDualActive(newActive);

    Logger.debug('[DUAL-SWITCH] 📊 After switch: now controlling=' + (newActive ? 'DUAL' : 'MAIN'));

    // Reset dual death counter and unblock respawn when switching TO dual
    // User is finally paying attention to their dual, so give it another chance
    if (newActive && dualPlayer) {
        if (dualPlayer.dualDeathsWhileInactive > 0 || dualPlayer.dualRespawnBlocked) {
            Logger.info('[DUAL-SWITCH] 🔄 Resetting dual death counter. Was: ' +
                dualPlayer.dualDeathsWhileInactive + ' deaths, blocked: ' + dualPlayer.dualRespawnBlocked);
        }
        dualPlayer.dualDeathsWhileInactive = 0;
        dualPlayer.dualRespawnBlocked = false;
        dualPlayer._deathAlreadyCounted = false;
    }

    // IMPORTANT: Tab switch should NEVER be blocked!
    // We ONLY switch control - we do NOT respawn players here.
    // Auto-respawn system will handle respawning when allowed.

    // Just switch - no respawn attempts
    // The player will respawn via normal auto-respawn when cooldown/team allows
    Logger.debug('[DUAL-SWITCH] ✅ Switch complete. Respawn will happen via auto-respawn system.');
};

// Handle create dual player request
PacketHandler.prototype.handleRequestCreateDual = function () {
    Logger.debug('[DUAL] handleRequestCreateDual called (opcode 25)');

    var tm = this.gameServer.tournamentManager;
    var player = this.socket.playerTracker;

    if (tm && tm.isActive) {
        // Block during PAUSE - no dual spawn allowed
        if (tm.isPaused) {
            Logger.debug('[DUAL] Create dual request rejected - tournament paused');
            return;
        }

        // Check if team is full BEFORE allowing dual creation
        if (player && player.discordId) {
            var team = tm.getPlayerTeam(player.discordId);
            if (team) {
                var spawnError = tm.canPlayerSpawn(player, true); // true = isDual
                if (spawnError) {
                    Logger.debug('[DUAL] Create dual request rejected - ' + spawnError);
                    // Silently block - don't spam chat with "Team is full" messages
                    return;
                }
            }
        }

        // During FROZEN: allow spawn ONCE only (for prep time)
        if (tm.isFrozen) {
            if (player && player._tournamentDualSpawned) {
                Logger.debug('[DUAL] Create dual request rejected - already spawned during freeze');
                return;
            }
            // Mark as spawned during this freeze period
            if (player) {
                player._tournamentDualSpawned = true;
            }
        }
    }

    // Check if dual is disabled in config
    if (this.gameServer.config.dualDisabled) {
        Logger.debug('[DUAL] Create dual request rejected - dual is disabled in this game mode');
        if (player) {
            this.gameServer.sendChatMessage(null, player, "In this mode dual is disabled");
        }
        return;
    }

    if (player) {
        player.createDualPlayer();
    }
};

// Handle preference toggle packets (opcodes 26-29)
PacketHandler.prototype.handleVanisPreferenceToggle = function (prefOpcode, reader) {
    var enabled = reader.remaining() > 0 ? reader.readUInt8() > 0 : false;
    this._applyPreferenceToggle(prefOpcode, enabled);
};

// Apply preference toggle to player
PacketHandler.prototype._applyPreferenceToggle = function (prefOpcode, enabled) {
    var tracker = this.socket.playerTracker;
    if (!tracker) return;

    switch (prefOpcode) {
        case 26: // Remember ejecting toggle
            tracker.clientWantsRememberEjecting = enabled;
            if (!enabled) {
                tracker.ejectMacro = false;
                if (tracker.dualPlayer) {
                    tracker.dualPlayer.ejectMacro = false;
                }
            }
            Logger.debug('[PREFERENCES] Remember ejecting ' + (enabled ? 'ON' : 'OFF') + ' for PID=' + tracker.pID);
            break;
        case 27: // Minion control toggle
            tracker.setMinionControlPreference(enabled);
            break;
        case 28: // Remember mouse position toggle (legacy opcode)
            tracker.clientWantsRememberMousePosition = enabled;
            tracker.clientWantsLockInactivePosition = !enabled;
            if (tracker.dualPlayer) {
                tracker.dualPlayer.clientWantsRememberMousePosition = enabled;
                tracker.dualPlayer.clientWantsLockInactivePosition = !enabled;
            }
            if (!enabled) {
                tracker.isLockedToPosition = true;
                tracker.lockedMouseX = tracker.mouse.x;
                tracker.lockedMouseY = tracker.mouse.y;
                if (tracker.dualPlayer) {
                    tracker.dualPlayer.isLockedToPosition = true;
                    tracker.dualPlayer.lockedMouseX = tracker.dualPlayer.mouse.x;
                    tracker.dualPlayer.lockedMouseY = tracker.dualPlayer.mouse.y;
                }
            } else {
                tracker.isLockedToPosition = false;
                if (tracker.dualPlayer) {
                    tracker.dualPlayer.isLockedToPosition = false;
                }
            }
            Logger.debug('[PREFERENCES] Remember mouse position ' + (enabled ? 'ON' : 'OFF') + ' for PID=' + tracker.pID);
            break;
        case 29: // Remember mouse position toggle
            tracker.clientWantsRememberMousePosition = enabled;
            if (tracker.dualPlayer) {
                tracker.dualPlayer.clientWantsRememberMousePosition = enabled;
            }
            if (enabled) {
                tracker.clientWantsLockInactivePosition = false;
                if (tracker.dualPlayer) {
                    tracker.dualPlayer.clientWantsLockInactivePosition = false;
                }
            }
            Logger.debug('[PREFERENCES] Remember mouse position ' + (enabled ? 'ON' : 'OFF') + ' for PID=' + tracker.pID);
            break;
    }
};

// Handle dual nickname set (opcode 30) - with locked name check
PacketHandler.prototype.handleVanisDualNickname = function (reader) {
    var tracker = this.socket.playerTracker;
    if (!tracker) return;
    var self = this;

    try {
        var ownerFallback = tracker._name || '';
        var requestedName = reader.readStringUTF8() || '';

        requestedName = requestedName.trim();
        if (requestedName.length > 15) {
            requestedName = requestedName.substring(0, 15);
        }

        // Check locked name - if dual nickname is a locked name owned by someone else, revert to owner's name
        if (requestedName && requestedName !== ownerFallback) {
            this.gameServer.checkNameLock(requestedName, tracker.discordToken, function (err, result) {
                var finalName = requestedName;

                if (!err && result && result.locked && !result.isOwner) {
                    // Name is locked by another user - revert to owner's name
                    Logger.info('[DUAL] Dual nickname "' + requestedName + '" is locked. Reverting to owner name "' + ownerFallback + '"');
                    finalName = ownerFallback;
                }

                self._applyDualNickname(tracker, finalName);
            });
        } else {
            // No need to check, just apply
            var finalName = requestedName || ownerFallback;
            this._applyDualNickname(tracker, finalName);
        }
    } catch (e) {
        Logger.error('[DUAL] Error setting dual nickname: ' + e.message);
    }
};

// Apply dual nickname after lock check
PacketHandler.prototype._applyDualNickname = function (tracker, finalName) {
    tracker.dualNickname = finalName;
    Logger.debug('[DUAL] Set dual nickname to: ' + finalName + ' for PID=' + tracker.pID);

    // Update dual player if it exists
    if (tracker.dualPlayer && typeof tracker._getDualIdentity === 'function') {
        var identity = tracker._getDualIdentity();
        tracker.dualPlayer.setName(identity.name);
        tracker.dualPlayer.lastSpawnName = tracker.dualPlayer._name;
        if (typeof tracker._applyDualNameColorLock === 'function') {
            tracker._applyDualNameColorLock(tracker.dualPlayer, identity.name);
        }
    }
};

// Handle dual skin URL set (opcode 31)
PacketHandler.prototype.handleVanisDualSkin = function (reader) {
    var tracker = this.socket.playerTracker;
    if (!tracker) return;

    try {
        var skin = reader.readStringUTF8();
        if (skin) {
            if (skin.length > 200) skin = skin.substring(0, 200); // Reasonable limit
            tracker.dualSkinUrl = skin;
            Logger.debug('[DUAL] Set dual skin URL for PID=' + tracker.pID);
        } else {
            tracker.dualSkinUrl = "";
            Logger.debug('[DUAL] Cleared dual skin URL for PID=' + tracker.pID);
        }

        // Update dual player if it exists
        if (tracker.dualPlayer && typeof tracker._getDualIdentity === 'function') {
            var identity = tracker._getDualIdentity();
            tracker.dualPlayer.setSkin(identity.skin);
            tracker.dualPlayer.lastSpawnSkin = tracker.dualPlayer._skin;
        }
    } catch (e) {
        Logger.error('[DUAL] Error setting dual skin: ' + e.message);
    }
};

// Handle dual minion commands (opcodes 32-45)
PacketHandler.prototype.handleDualMinionCommand = function (opcode, reader) {
    var tm = this.gameServer.tournamentManager;
    var player = this.socket.playerTracker;

    if (tm && tm.isActive) {
        // Block during PAUSE completely
        if (tm.isPaused) {
            Logger.debug('[DUAL-MINION] Command rejected - tournament paused');
            return;
        }

        // During FROZEN: block respawn (43) if already spawned once
        if (tm.isFrozen && opcode === 43) {
            if (player && player._tournamentDualSpawned) {
                Logger.debug('[DUAL-MINION] Respawn rejected - already spawned during freeze');
                return;
            }
            if (player) {
                player._tournamentDualSpawned = true;
            }
        }
    }

    var value = reader.remaining() > 0 ? reader.readUInt8() : 0;
    Logger.debug('[DUAL-MINION] Command received opcode=' + opcode + ' value=' + value);
    this._handleDualMinionCommand(opcode, value);
};

// Process dual minion commands
PacketHandler.prototype._handleDualMinionCommand = function (command, value) {
    var owner = this.socket.playerTracker;

    Logger.debug('[DUAL-MINION] 🔍 Processing command=' + command + ' value=' + value +
        ' owner=' + (owner ? 'PID=' + owner.pID : 'null') +
        ' minionControlActive=' + (owner ? owner.minionControlActive : 'false'));

    if (!owner) {
        Logger.debug('[DUAL-MINION] ❌ Command ' + command + ' ignored - no owner tracker');
        return;
    }

    // Respawn command (43) should work regardless of minionControlActive
    // Because user might want to respawn their dead dual without entering minion mode
    var isRespawnCommand = (command === 43);

    if (!owner.minionControlActive && !isRespawnCommand) {
        Logger.debug('[DUAL-MINION] ❌ Command ' + command + ' ignored - minionControlActive=false for PID=' + owner.pID);
        return;
    }

    if (!owner.dualPlayer) {
        Logger.debug('[DUAL-MINION] ❌ Command ' + command + ' ignored - dual player not spawned for PID=' + owner.pID);
        return;
    }

    var dual = owner.dualPlayer;
    if (dual.isRemoved) {
        Logger.debug('[DUAL-MINION] ❌ Command ' + command + ' ignored - dual player removed for PID=' + owner.pID);
        return;
    }

    Logger.debug('[DUAL-MINION] ✅ Command ' + command + ' proceeding - owner PID=' + owner.pID + ' dual PID=' + dual.pID + ' dualCells=' + dual.cells.length);

    // Split command mapping
    var splitMap = {
        32: 5, // Split32
        33: 6, // Split64
        34: 7, // Split128
        35: 8, // Split256
        36: 2, // Doublesplit
        37: 3, // Triplesplit
        38: 4  // Quadsplit
    };

    if (splitMap.hasOwnProperty(command)) {
        this._queueDualSplitAttempts(dual, splitMap[command]);
        return;
    }

    switch (command) {
        case 39: // Feed once
            if (dual.cells.length > 0) {
                dual.pressW();
            }
            break;
        case 40: // Feed macro on
            dual.ejectMacro = true;
            dual.lastEject = null;
            break;
        case 41: // Diagonal linesplit (reserved)
            // Reserved for future implementation
            break;
        case 42: // Toggle lock linesplit (reserved)
            // Reserved for future implementation
            break;
        case 43: // Respawn dual
            var tick = this.gameServer.tickCounter;
            // Add minimum delay between respawn attempts (~1.3 seconds = 33 ticks at 25 TPS)
            if (tick - (this.lastMinionRespawnTick || 0) < 33) {
                return;
            }

            // TOURNAMENT: Check respawn cooldown before allowing dual respawn
            var tm = this.gameServer.tournamentManager;
            if (tm && tm.isActive) {
                var discordId = owner ? owner.discordId : null;
                if (discordId) {
                    var cooldownCheck = tm.checkRespawnCooldown(discordId);
                    if (!cooldownCheck.canRespawn) {
                        Logger.info('[DUAL] Manual respawn blocked - cooldown: ' + cooldownCheck.remainingTime.toFixed(1) + 's');
                        this.gameServer.sendChatMessage(null, owner, 'Respawn cooldown: ' + Math.ceil(cooldownCheck.remainingTime) + 's');
                        return;
                    }
                    // Start cooldown for owner (applies to both main and dual)
                    tm.startRespawnCooldown(discordId);
                }
            }

            this.lastMinionRespawnTick = tick;
            this._respawnDualPlayer(dual);
            break;
        case 44: // Feed macro off
            dual.ejectMacro = false;
            break;
        case 45: // Generic minion split with payload
            var splitCount = value > 0 ? value : 1;
            splitCount = Math.max(1, Math.min(splitCount, 8));
            this._queueDualSplitAttempts(dual, splitCount);
            break;
        default:
            Logger.debug('[MINION] Received unknown minion command opcode=' + command + ' for PID=' + owner.pID);
            break;
    }
};

// Queue split attempts for dual player
PacketHandler.prototype._queueDualSplitAttempts = function (dual, count) {
    if (!dual || count <= 0) return;
    if (dual.cells.length === 0) {
        Logger.debug('[MINION] Split command ignored - dual has no cells (PID=' + dual.pID + ')');
        return;
    }

    // Already at max cells? Don't bother queuing more splits
    var maxCells = this.gameServer.config.playerMaxCells || 16;
    if (dual.cells.length >= maxCells) {
        Logger.debug('[MINION] Split command ignored - dual already at max cells (PID=' + dual.pID + ')');
        dual.splitAttempts = 0;
        dual.splitAttemptsInitial = 0;
        return;
    }

    // Cap the queue at 128 max
    var maxQueue = this.gameServer.config.playerSplitQueueMax || 128;

    // Only set initial when queue is empty
    if (!dual.splitAttempts || dual.splitAttempts <= 0) {
        dual.splitAttemptsInitial = Math.min(count, maxQueue);
    }

    var newTotal = (dual.splitAttempts || 0) + count;
    dual.splitAttempts = Math.min(newTotal, maxQueue);
    dual.splitAttemptsTick = this.gameServer.tickCounter;
};

// Respawn dual player - turns existing cells into dead cells and spawns fresh
PacketHandler.prototype._respawnDualPlayer = function (dual) {
    if (!dual) return;
    var owner = dual.ownerPlayer;
    var PlayerCell = require('./entity/PlayerCell');
    Logger.info('[DUAL] Manual respawn requested for PID=' + dual.pID);

    // dead cells

    while (dual.cells.length > 0) {
        var cell = dual.cells[0];

        // Create a new dead cell at the same position

        var deadCell = new PlayerCell(this.gameServer, null, { x: cell.position.x, y: cell.position.y }, cell._size);
        deadCell.setColor({ r: 33, g: 33, b: 33 }); // Dark gray - the color of defeat
        deadCell.isDead = true;
        deadCell.deadTick = this.gameServer.tickCounter;

        this.gameServer.addNode(deadCell);

        // Remove the old cell (removes from dual.cells too)
        this.gameServer.removeNode(cell);
    }

    // Restore dual identity from owner or stored values
    var dualName = (owner && owner.dualNickname) ? owner.dualNickname.trim() : '';
    if (dualName.length > 15) dualName = dualName.substring(0, 15);
    var dualSkin = (owner && owner.dualSkinUrl) ? owner.dualSkinUrl.trim() : '';

    var name = dualName ||
        dual.lastSpawnName || (owner && owner.lastSpawnName) || dual._name || '';
    var skin = dualSkin ||
        dual.lastSpawnSkin || (owner && owner.lastSpawnSkin) || dual._skin || '';

    if (owner && owner._tag !== undefined) {
        dual._tag = owner._tag;
    }

    // If owner has cells (alive), use random spawn position for dual
    // This matches main player behavior when manually respawning while alive
    var useRandomSpawn = owner && owner.cells && owner.cells.length > 0;
    if (useRandomSpawn) {
        dual.shouldUseNearDeathSpawn = false; // Force random spawn
        Logger.info('[DUAL] Owner alive with ' + owner.cells.length + ' cells - dual will spawn at random position');
    }

    dual.clearAutoRespawnTimer();
    dual.joinGame(name, skin, { context: 'manual_dual', allowRespawnWithCells: true, forceRandomSpawn: useRandomSpawn });

    if (owner && typeof owner._applyDualNameColorLock === 'function') {
        owner._applyDualNameColorLock(dual, name);
    }

    Logger.info('[DUAL] Respawned dual PID=' + dual.pID + ' cells=' + dual.cells.length);
};

// Send dual player update packet to client
PacketHandler.prototype.sendDualPlayerUpdate = function (player) {
    var multiboxPid = 0;
    var activePid = player.pID;

    // Determine correct PIDs based on who is calling this
    var rootPlayer = player;
    if (player.playerType === 'DUAL_MINION' && player.ownerPlayer) {
        rootPlayer = player.ownerPlayer;
    }

    if (rootPlayer.dualPlayer) {
        multiboxPid = rootPlayer.dualPlayer.pID;
    }

    if (rootPlayer.isDualActive && rootPlayer.dualPlayer) {
        activePid = rootPlayer.dualPlayer.pID;
    } else {
        activePid = rootPlayer.pID;
    }

    var writer = new VanisWriter();
    writer.writeUInt8(24); // DualPlayerUpdate opcode
    writer.writeUInt16(multiboxPid);
    writer.writeUInt16(activePid);

    this.socket.send(writer.finalize());
};

// Broadcast player info to all clients
PacketHandler.prototype.broadcastPlayerInfo = function (player) {
    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client && client.packetHandler && client.packetHandler.isVanis && client.isConnected) {
            if (typeof client.packetHandler.sendVanisPlayerInfo === 'function') {
                client.packetHandler.sendVanisPlayerInfo(player);
            } else {
                Logger.warn('[DUAL] broadcastPlayerInfo skipped client without sendVanisPlayerInfo function');
            }
        }
    }
};

// Propagate mouse position to partner player (dual or owner)
// This syncs mouse when minion control or remember mouse is active
PacketHandler.prototype._propagateMouseToPartner = function (client, x, y, options) {
    if (!client) return;
    options = options || {};

    // Find the owner (could be client itself or client's owner if dual)
    var owner = (client.playerType === 'DUAL_MINION' && client.ownerPlayer) ? client.ownerPlayer : client;
    if (!owner.dualPlayer) return;

    // Determine who the partner is (the other player in the dual pair)
    var partner = (client === owner) ? owner.dualPlayer : owner;
    if (!partner) return;

    // Check if we should sync mouse positions
    var wantsRemember = owner.clientWantsRememberMousePosition || owner.minionControlActive;

    if (!wantsRemember) {
        // Not syncing - keep partner locked to their position
        if (partner.isLockedToPosition) {
            partner.mouse.x = partner.lockedMouseX;
            partner.mouse.y = partner.lockedMouseY;
        }
        return;
    }

    // Sync mouse position to partner
    partner.mouse.x = x;
    partner.mouse.y = y;

    if (!options.skipLockState) {
        partner.lockedMouseX = x;
        partner.lockedMouseY = y;
        partner.isLockedToPosition = false;
    }
};

// ========================================
// CAPTCHA & SECURITY HANDLERS

// ========================================

/**
 * Handle hCaptcha token from client (opcode 251)
 * This is sent when client completes the hCaptcha challenge
 */
PacketHandler.prototype.handleVanisCaptchaToken = function (reader) {
    // Already verified? We're done here
    if (this.socket.captchaVerified) return;

    // Captcha disabled? Auto-verify
    if (!this.captchaRequired) {
        this.socket.captchaVerified = true;
        this.captchaDeadline = null;
        Logger.debug('[CAPTCHA] Captcha disabled via config - auto-verified');
        return;
    }

    try {
        if (reader.remaining() < 2) return;

        // Read token length (try both LE and BE because clients are inconsistent)
        var b1 = reader.readUInt8();
        var b2 = reader.readUInt8();
        var lenLE = (b1 | (b2 << 8)) >>> 0;
        var lenBE = ((b1 << 8) | b2) >>> 0;
        var remaining = reader.remaining();
        var len = 0;

        if (lenLE > 0 && lenLE <= 4096 && lenLE <= remaining) {
            len = lenLE;
        } else if (lenBE > 0 && lenBE <= 4096 && lenBE <= remaining) {
            len = lenBE;
        }

        if (len === 0) return;

        var token = reader.readBytes(len).toString('utf8');
        var remoteIp = this.socket.remoteAddress || 'unknown';
        var self = this;

        Logger.info('[CAPTCHA] Token received (len=' + token.length + ') from ' + remoteIp);

        // ========================================
        // DISCORD BYPASS FLOW
        // Client sends 'discord_bypass' as token to indicate Discord login
        // They MUST provide valid Discord token with User ID in PlayerInfo
        // ========================================
        if (token === 'discord_bypass') {
            Logger.info('[CAPTCHA]  Discord bypass requested - awaiting PlayerInfo with valid Discord token');
            this.socket.discordBypass = true;
            this.socket.discordBypassValidated = false;
            this._sendInitialWorldIfReady();
            return;
        }

        // ========================================
        // NORMAL hCAPTCHA VERIFICATION
        // ========================================

        // Check for token reuse (bots love reusing tokens)
        if (this.gameServer.isCaptchaTokenUsed && this.gameServer.isCaptchaTokenUsed(token, remoteIp)) {
            Logger.info('[CAPTCHA]  Reused token rejected from ' + remoteIp);
            try { this.socket.close(1008, 'Verification failed'); } catch (e) { }
            return;
        }

        // Verify with hCaptcha server
        this.gameServer
            .verifyCaptchaToken(token, remoteIp, null)
            .then(function (result) {
                if (!result || !result.ok) {
                    Logger.info('[CAPTCHA]  Verification failed: ' + ((result && result.code) || 'unknown'));
                    try { self.socket.close(1008, 'Verification failed'); } catch (e) { }
                    return;
                }

                // Mark token as used to prevent replay
                if (self.gameServer.markCaptchaTokenUsed) {
                    self.gameServer.markCaptchaTokenUsed(token, remoteIp);
                }

                self.socket.captchaVerified = true;
                self.captchaDeadline = null;
                Logger.info('[CAPTCHA] Verification success for ' + remoteIp);
                self._sendInitialWorldIfReady();
            })
            .catch(function (err) {
                Logger.error('[CAPTCHA] Verification error: ' + err.message);
                try { self.socket.close(1011, 'Verification error'); } catch (e) { }
            });

    } catch (err) {
        Logger.debug('[CAPTCHA] Malformed captcha token: ' + err.message);
    }
};

/**
 * Validate Discord bypass with User ID extraction (this is really op)
 * SECURITY: Must extract Discord User ID for rate limiting
 * @param {string} token - Discord token
 * @param {Function} callback - callback(err, {valid: boolean, discordUserId: string, discordName: string})
 */
PacketHandler.prototype._validateDiscordBypassWithUserId = function (token, callback) {
    if (!token || !this.gameServer.validateDiscordTokenWithUserId) {
        // Fallback to basic validation
        this.gameServer.validateDiscordToken(token, function (err, isValid) {
            if (err || !isValid) {
                callback(err || new Error('Invalid token'), null);
            } else {
                // Basic validation without User ID - still allow but log warning
                Logger.warn('[CAPTCHA]  Discord bypass without User ID extraction - less secure');
                callback(null, { valid: true, discordUserId: null, discordName: null });
            }
        });
        return;
    }

    this.gameServer.validateDiscordTokenWithUserId(token, callback);
};

/**
 * Synchronous Discord token validation (for join flow)
 * Returns cached result or false
 */
PacketHandler.prototype._validateDiscordTokenSync = function (token) {
    if (!token) return false;

    // Check if already validated via bypass flow
    if (this.socket.discordBypassValidated && this.socket.captchaVerified) {
        return true;
    }

    // Check bypass security manager cache
    if (this.gameServer.bypassSecurityManager && this.socket.discordUserId) {
        return this.gameServer.bypassSecurityManager.isUserIdVerified(this.socket.discordUserId);
    }

    return false;
};

/**
 * Continue PlayerInfo processing after Discord bypass validation
 */
PacketHandler.prototype._continuePlayerInfoProcessing = function (name, discord) {
    var player = this.socket.playerTracker;
    if (!player) return;

    var self = this;

    // Set discord token if provided
    if (discord && discord.length > 0) {
        player.discordToken = discord.trim();
        Logger.debug('[VANIS] Discord token set for player after bypass validation');
    }

    // Process name if provided
    var cleanName = '';
    if (name) {
        cleanName = name;
        // Strip skin tags if present
        if (name[0] === '<') {
            var tagEnd = name.indexOf('>');
            if (tagEnd >= 1) {
                cleanName = name.slice(tagEnd + 1);
            }
        }

        // Truncate if too long
        if (cleanName.length > this.gameServer.config.playerMaxNickLength) {
            cleanName = cleanName.substring(0, this.gameServer.config.playerMaxNickLength);
        }

        // Check bad words
        if (this.gameServer.checkBadWord(cleanName)) {
            cleanName = "Hi there!";
        }
    }

    // Check name lock if name provided
    if (cleanName && cleanName.length > 0) {
        this.gameServer.checkNameLock(cleanName, discord, function (err, result) {
            var finalName = cleanName;

            if (err) {
                Logger.debug('[NAME-LOCK] API check failed, allowing: ' + err.message);
            } else if (result && result.locked && !result.isOwner) {
                Logger.debug('[NAME-LOCK]  Locked name, setting unnamed: ' + cleanName);
                self.sendVanisChat(null, ' This name is locked by another player!');
                finalName = '';
            } else if (result && result.locked && result.isOwner) {
                Logger.debug('[NAME-LOCK]  Player is owner of locked name: ' + cleanName);
            }

            if (finalName) {
                player._name = finalName;
            }
            self._processPlayerInfoToken(player, discord);
        });
    } else {
        // No name - just process token
        this._processPlayerInfoToken(player, discord);
    }
};

/**
 * Close socket with error message
 */
PacketHandler.prototype._closeSocket = function (code, message) {
    try {
        if (this.socket && this.socket.close) {
            this.socket.close(code, message);
        }
    } catch (e) {
        // Socket probably already closed, who cares
    }
};


