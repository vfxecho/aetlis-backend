// PlayerTracker.js - Combined Legacy + Vanis Support
// Tracks players like a pro stalker but legally

var Packet = require('./packet');
var BinaryWriter = require("./packet/BinaryWriter");
var Logger = require('./modules/Logger');

function PlayerTracker(gameServer, socket) {
    this.gameServer = gameServer;
    this.socket = socket;
    this.pID = -1;
    this.userAuth = null;
    this.isRemoved = false;
    this.isCloseRequested = false;
    this._name = "";
    this._skin = "";
    this._tag = ""; // Team tag for player isolation
    this._nameUtf8 = null;
    this._nameUnicode = null;
    this._skinUtf8 = null;
    this.color = { r: 0, g: 0, b: 0 };
    this.viewNodes = [];
    this.clientNodes = [];
    this.cells = [];
    this.mergeOverride = false;
    this._score = 0;
    this._scale = 1;
    this.isMassChanged = true;
    this.borderCounter = 0;
    this.connectedTime = new Date();

    this.team = 0;
    this.spectate = false;
    this.freeRoam = false;      // Free-roam mode enables player to move in spectate mode
    this.spectateTargetPid = null; // Specific player ID to spectate (null = largest player)
    this.lastKeypressTick = 0;

    this.centerPos = { x: 0, y: 0 };
    this.lastKnownCenter = null; // Last center when player had cells (for spectating)
    this.mouse = { x: 0, y: 0 };
    this.viewBox = {
        minx: 0, miny: 0,
        maxx: 0, maxy: 0,
        halfWidth: 0, halfHeight: 0
    };

    // 
    this.scrambleX = 0;
    this.scrambleY = 0;
    this.scrambleId = 0;
    this.isMinion = false;
    this.isBot = !!(socket && socket.isBot); // Bots have isBot=true on their socket
    this.isMuted = false;

    // Custom commands
    this.spawnmass = 0;
    this.frozen = false;
    this.customspeed = 0;
    this.rec = false;

    // Spawn protection
    this.spawnTick = -1; // Tick when player spawned (for spawn protection, -1 = never spawned)
    this.lastPop = null; // Tick when player was last popped (for eject pop delay protection)

    // Eject macro for Vanis clients
    this.ejectMacro = false;

    // Auto respawn preference from client
    this.clientAutoRespawnEnabled = true;
    this.lastEject = null;

    // Mouse projection collision (linesplit x diagonal linesplit)
    this.isLineLocked = false;
    this.specialLineSplitLockActive = false;
    this.useMouseProjectionCollision = false;
    this.needsProjectionReactivation = false;
    this.projectionActiveUntilTick = 0;
    this.projectionActivatedTick = 0;
    this.lockedMouse = { x: 0, y: 0 }; // Locked mouse position for projection
    this.diagonalSnapDisabled = false; // Diagonal snap suppression
    this.lastDiagonalSplitTick = 0; // Last tick when diagonal split was triggered

    // Split queue (split64, doublesplit, etc)
    this.splitAttempts = 0;
    this.splitAttemptsTick = 0;
    this.splitAttemptsInitial = 0; // Tracks initial queue size for decay calculation

    // Feeding flag for reverse split order (crosses selfeed)
    this.isFeedingThisTick = false;

    // XP & Account System
    this.discordToken = null;
    this.discordName = null;
    this.currentXP = 0;
    this.currentLevel = 1;
    this.seasonXP = 0;

    // Session XP tracking - nigger
    this.sessionXP = 0;              // Total XP gained this session (with level coefficient)
    this.sessionSeasonXP = 0;        // Season XP gained this session (flat, no level penalty)
    this.sessionStartTime = Date.now();
    this.sessionPeakMass = 0;
    this.sessionCellsEaten = 0;

    // Active Play Time Tracking (only counts when actually playing, not spectating)
    this.activePlayStartTime = 0;    // When player spawned (0 = not playing)
    this.totalActivePlayTime = 0;    // Total milliseconds of active play
    this.isCurrentlyPlaying = false; // Is player currently spawned and playing

    // AFK Detection - are you still there?
    this.lastActionTime = Date.now(); // Last time player pressed split/feed or did any action
    this.afkWarned = false;
    this.afkCheckInterval = null;

    // color names - because gay
    this.nameColor = null; // Hex color string without # prefix (e.g., "FF0000")
    this.nameColorEnabled = false; // Whether player has permission to use custom name color
    this.lockedNameNormalized = ""; // Lowercase name that unlocks perks/color

    // Badge System
    this.badgeId = 0; // Badge ID (0 = no badge)

    // Admin System - because someone has to keep order
    // 0 = normal, 1 = moderator (mute/tp/virus), 2 = full admin (all commands)
    this.adminLevel = 0;
    this.discordId = null; // Store Discord ID for permission checks
    this.isReferee = false; // Tournament referee status
    this.isTeleporter = false; // Can only /teleport in tournament servers

    // Perks refresh tracking
    this.perksRefreshInterval = null;
    this._lastBroadcastNameColor = null;
    this._lastBroadcastBadgeId = null;
    this._lastBroadcastColorEnabled = null;

    // Dual Player System (Multibox)
    this.playerType = 'REGULAR'; // 'REGULAR' or 'DUAL_MINION'
    this.dualPlayer = null; // Reference to dual player (for owner)
    this.ownerPlayer = null; // Reference to owner player (for dual minion)
    this.isDualActive = false; // Whether dual player is currently active (for owner)
    this.minionControlActive = false; // Whether minion control mode is enabled
    this.clientWantsRememberEjecting = false; // Client preference for eject state
    this.clientWantsLockInactivePosition = false; // Legacy client preference for locking inactive player
    this.clientWantsRememberMousePosition = false; // New preference: keep inactive mouse synced
    this.isLockedToPosition = false; // Whether this player is locked to a specific position
    this.lockedMouseX = 0; // Locked mouse X position //outaded not used
    this.lockedMouseY = 0; // Locked mouse Y position //outaded not used
    this.dualNickname = ""; // Custom nickname for dual player
    this.dualSkinUrl = ""; // Custom skin URL for dual player

    // Dual Death Tracking - stop respawning that ass if you're not even watching
    // Basically: if dual keeps dying while you're not controlling it, stop respawning nigga
    this.dualDeathsWhileInactive = 0; // How many times dual died while we weren't babysitting
    this.dualRespawnBlocked = false; // If true, dual won't auto-respawn until you tab switch to it
    this._deathAlreadyCounted = false; // Flag to prevent counting the same death multiple times

    // Main Death Tracking (symmetric - for when controlling dual and main keeps dying)
    // Same logic: if main dies 3+ times while user is controlling dual, block main respawn
    this.mainDeathsWhileInactive = 0;
    this.mainRespawnBlocked = false;
    this._mainDeathAlreadyCounted = false;

    // Auto Respawn System - Because dying shouldn't mean starting over
    this.autoRespawnTimer = null; // Timer for automatic respawn
    this.lastSpawnName = ""; // Last name used for spawning
    this.lastSpawnSkin = ""; // Last skin used for spawning
    this.lastSpawnContext = 'manual'; // Last spawn context (manual, auto, etc.)
    this.lastKnownCenter = { x: 0, y: 0 }; // Remember last camera center for smoother switching

    // Death tracking for near-death respawn
    this.lastDeathPosition = null; // {x, y} - Last position where player died
    this.lastKillerCell = null; // Reference to the cell that killed the player
    this.shouldUseNearDeathSpawn = false; // Flag for FFA to use near-death spawn

    // Minions (why this shit exists)
    this.miQ = 0;
    this.isMi = false;
    this.minionSplit = false;
    this.minionEject = false;
    this.minionFrozen = false;
    this.minionControl = false;
    this.collectPellets = false;

    // Initialize if we have a gameServer
    if (gameServer) {
        this.centerPos.x = 0;
        this.centerPos.y = 0;
        this.pID = gameServer.lastPlayerId++ >> 0;
        gameServer.gameMode.onPlayerInit(this);
        this.scramble();
    }

    var UserRoleEnum = require("./enum/UserRoleEnum");
    this.userRole = UserRoleEnum.GUEST;
}

module.exports = PlayerTracker;

// =====================================
// SETTERS/GETTERS - The boring but necessary stuff
// =====================================

PlayerTracker.prototype.scramble = function () {
    if (!this.gameServer.config.serverScrambleLevel) {
        this.scrambleId = 0;
        this.scrambleX = 0;
        this.scrambleY = 0;
    } else {
        this.scrambleId = (Math.random() * 0xFFFFFFFF) >>> 0;
        var maxx = Math.max(0, 31767 - this.gameServer.border.width);
        var maxy = Math.max(0, 31767 - this.gameServer.border.height);
        var x = maxx * Math.random();
        var y = maxy * Math.random();
        if (Math.random() >= 0.5) x = -x;
        if (Math.random() >= 0.5) y = -y;
        this.scrambleX = x;
        this.scrambleY = y;
    }
    this.borderCounter = 0;
};

PlayerTracker.prototype.setName = function (name) {
    this._name = name;
    if (!name || !name.length) {
        this._nameUnicode = null;
        this._nameUtf8 = null;
        return;
    }
    var writer = new BinaryWriter();
    writer.writeStringZeroUnicode(name);
    this._nameUnicode = writer.toBuffer();
    writer = new BinaryWriter();
    writer.writeStringZeroUtf8(name);
    this._nameUtf8 = writer.toBuffer();
};

PlayerTracker.prototype.setSkin = function (skin) {
    // Only broadcast skins from skins.aetlis.io - other skins are accepted but not broadcasted to other players
    if (skin && skin.length > 0 && !skin.startsWith("https://skins.aetlis.io/s/")) {
        skin = ""; // Clear skin if not from allowed domain
    }

    this._skin = skin;
    if (!skin || !skin.length) {
        this._skinUtf8 = null;
        return;
    }
    var writer = new BinaryWriter();
    writer.writeStringZeroUtf8(skin);
    this._skinUtf8 = writer.toBuffer();
};

PlayerTracker.prototype.setColor = function (color) {
    this.color.r = color.r;
    this.color.g = color.g;
    this.color.b = color.b;
};

PlayerTracker.prototype.getScale = function () {
    if (this.isMassChanged) this.updateMass();
    return this._scale;
};

PlayerTracker.prototype.updateMass = function () {
    this._score = 0;
    this._scale = 0;
    for (var i = 0; i < this.cells.length; i++) {
        if (!this.cells[i]) continue;
        this._scale += this.cells[i]._size;
        this._score += this.cells[i]._mass;
    }
    if (this._scale) this._scale = Math.pow(Math.min(64 / this._scale, 1), 0.4);
    this.isMassChanged = false;
};

// =====================================
// JOIN GAME
// =====================================

PlayerTracker.prototype.joinGame = function (name, skin, options) {
    options = options || {};
    var spawnContext = options.context || 'manual';
    var allowRespawnWithCells = !!options.allowRespawnWithCells;
    this.lastSpawnContext = spawnContext;

    // Handle DUAL_MINION - ALWAYS use owner's dual identity settings
    // This ensures dual player always uses the custom nickname/skin set by owner
    // Don't let client-provided name/skin override the dual's configured identity
    if (this.playerType === 'DUAL_MINION' && this.ownerPlayer) {
        var dualIdentity = this.ownerPlayer._getDualIdentity ? this.ownerPlayer._getDualIdentity() : null;
        if (dualIdentity) {
            // ALWAYS use dual identity - this is the user's explicit choice
            name = dualIdentity.name;
            skin = dualIdentity.skin;
            Logger.info('[DUAL-IDENTITY] Applied dual identity: name="' + name + '" skin="' + (skin ? 'custom' : 'default') + '"');
        }
    }

    Logger.info('[JOIN] ========== joinGame() CALLED ==========');
    Logger.info('[JOIN] Player ID=' + this.pID + ' Name=' + (name || '') + ' Context=' + spawnContext);
    Logger.info('[JOIN] PlayerType=' + this.playerType);
    Logger.info('[JOIN] IsMinion=' + this.isMinion);
    Logger.info('[JOIN] Current cells=' + this.cells.length);
    Logger.info('[JOIN] OwnerPlayer=' + (this.ownerPlayer ? this.ownerPlayer.pID : 'none'));

    // TOURNAMENT MODE: Block non-registered players from joining
    // They can only spectate
    // But bots are allowed - they're our dummies
    if (this.gameServer && this.gameServer.tournamentData && this.gameServer.tournamentData.enabled) {
        if (!this.isBot && !this.isMi && this.playerType !== 'DUAL_MINION') {
            if (!this.gameServer.isAllowedToSpawn(this.discordId)) {
                // Only spam once
                if (!this._tournamentSpawnBlocked) {
                    this._tournamentSpawnBlocked = true;
                    Logger.info('[TOURNAMENT] 🚫 joinGame blocked for: ' + (this.discordName || 'Unknown') + ' (' + (this.discordId || 'no ID') + ')');
                    this.gameServer.sendChatMessage(null, this, "⚠️ Tournament Match: Only signed-up players can spawn. Enjoy spectating!");

                    // Tell the client to enter spectator mode - this is the magic packet
                    if (this.socket && this.socket.packetHandler && this.socket.packetHandler.sendVanisForceSpectate) {
                        this.socket.packetHandler.sendVanisForceSpectate();
                    }
                }
                // Force spectator mode on server side
                this.spectate = true;
                this.freeRoam = true;
                return; // Nope
            }
        }
    }

    // Block if player already has cells (unless allowed)
    if (this.cells.length && !allowRespawnWithCells) {
        Logger.debug('[JOIN] Blocked - player already has ' + this.cells.length + ' cells');
        return;
    }

    if (skin) this.setSkin(skin);
    if (!name) name = "";
    this.setName(name);

    // Save name and skin for auto-respawn
    this.lastSpawnName = name;
    this.lastSpawnSkin = skin || "";

    // Clear any pending auto-respawn timer
    this.clearAutoRespawnTimer();

    // Determine spawn type based on current cell count
    // If player has 0 cells (completely dead) → use near-death spawn
    // If player has 1+ cells (alive) → use random spawn
    // Dual players ALWAYS spawn near owner, not near death position

    Logger.info('[NEAR-SPAWN-FLAG-DEBUG] ========================================');
    Logger.info('[NEAR-SPAWN-FLAG-DEBUG] joinGame() spawn flag decision for PID=' + this.pID);
    Logger.info('[NEAR-SPAWN-FLAG-DEBUG] PlayerType: ' + this.playerType);
    Logger.info('[NEAR-SPAWN-FLAG-DEBUG] Current cells.length: ' + this.cells.length);
    Logger.info('[NEAR-SPAWN-FLAG-DEBUG] Has lastDeathPosition: ' + !!this.lastDeathPosition);
    if (this.lastDeathPosition) {
        Logger.info('[NEAR-SPAWN-FLAG-DEBUG] lastDeathPosition: (' +
            Math.floor(this.lastDeathPosition.x) + ', ' + Math.floor(this.lastDeathPosition.y) + ')');
        // Check if death position is within current border
        var border = this.gameServer.border;
        var deathInBounds = (
            this.lastDeathPosition.x >= border.minx &&
            this.lastDeathPosition.x <= border.maxx &&
            this.lastDeathPosition.y >= border.miny &&
            this.lastDeathPosition.y <= border.maxy
        );
        Logger.info('[NEAR-SPAWN-FLAG-DEBUG] Death pos in current border: ' + deathInBounds);
        if (!deathInBounds) {
            Logger.warn('[NEAR-SPAWN-FLAG-DEBUG]  Death position is OUTSIDE current border!');
            Logger.warn('[NEAR-SPAWN-FLAG-DEBUG]   Border: [' + Math.floor(border.minx) + ', ' + Math.floor(border.maxx) + '] x [' + Math.floor(border.miny) + ', ' + Math.floor(border.maxy) + ']');
        }
    }

    if (this.playerType !== 'DUAL_MINION') {
        this.shouldUseNearDeathSpawn = (this.cells.length === 0);
        Logger.info('[NEAR-SPAWN-FLAG-DEBUG] MAIN player: Setting shouldUseNearDeathSpawn=' + this.shouldUseNearDeathSpawn + ' (because cells.length=' + this.cells.length + ')');
        if (!this.shouldUseNearDeathSpawn) {
            Logger.info('[NEAR-SPAWN-FLAG-DEBUG]   ↳ REASON: Player still has cells, will use RANDOM spawn');
        } else if (!this.lastDeathPosition) {
            Logger.warn('[NEAR-SPAWN-FLAG-DEBUG]   ↳ WARNING: shouldUseNearDeathSpawn=true BUT no lastDeathPosition! Will fallback to random.');
        } else {
            Logger.info('[NEAR-SPAWN-FLAG-DEBUG]   ↳ Will attempt NEAR-DEATH spawn at (' + Math.floor(this.lastDeathPosition.x) + ', ' + Math.floor(this.lastDeathPosition.y) + ')');
        }
    } else {
        // Dual always spawns near owner, not near death position
        this.shouldUseNearDeathSpawn = false;
        Logger.info('[NEAR-SPAWN-FLAG-DEBUG] DUAL player: shouldUseNearDeathSpawn=false (duals spawn near owner)');
        if (this.ownerPlayer) {
            Logger.info('[NEAR-SPAWN-FLAG-DEBUG]   ↳ Owner PID=' + this.ownerPlayer.pID + ' cells=' + this.ownerPlayer.cells.length);
            if (this.ownerPlayer.cells.length > 0) {
                var ownerBiggest = this.ownerPlayer.cells.reduce(function (prev, curr) {
                    return (prev && prev._size > curr._size) ? prev : curr;
                }, this.ownerPlayer.cells[0]);
                Logger.info('[NEAR-SPAWN-FLAG-DEBUG]   ↳ Will spawn near owner cell at (' + Math.floor(ownerBiggest.position.x) + ', ' + Math.floor(ownerBiggest.position.y) + ')');
            } else {
                Logger.warn('[NEAR-SPAWN-FLAG-DEBUG]   ↳ Owner has NO CELLS, dual spawn may use random position!');
            }
        }
    }
    Logger.info('[NEAR-SPAWN-FLAG-DEBUG] ========================================');

    this.spectate = false;
    this.freeRoam = false;
    this.spectateTargetPid = null;

    // Check if this is a DUAL_MINION with a fake socket (no real sendPacket)
    var isDualMinion = this.playerType === 'DUAL_MINION';
    var hasRealSocket = this.socket && typeof this.socket.sendPacket === 'function';

    // Handle based on client type
    var isVanis = this.socket && this.socket.packetHandler && this.socket.packetHandler.isVanis;

    // Only send packets if we have a real socket (not dual minion's fake socket)
    if (!isDualMinion && hasRealSocket) {
        if (isVanis) {
            // Vanis client - don't send legacy packets
            // We MUST NOT clear clientNodes here if we aren't sending ClearAll (opcode 18).
            // Keeping clientNodes allows sendUpdate() to diff them against the new view
            // and naturally send delete packets for the old cells.

            // this.clientNodes = [];


            // Logger.debug('[JOIN] Vanis client spawning: ' + name);
        } else {
            // Legacy client
            if (this.socket.packetHandler && this.socket.packetHandler.protocol < 6)
                this.socket.sendPacket(new Packet.UpdateNodes(this, [], [], [], this.clientNodes));
            this.socket.sendPacket(new Packet.ClearAll());
            this.clientNodes = [];
            this.scramble();

            if (this.gameServer.config.serverScrambleLevel < 2) {
                this.socket.sendPacket(new Packet.SetBorder(this, this.gameServer.border));
            } else if (this.gameServer.config.serverScrambleLevel == 3) {
                var ran = 10065536 * Math.random();
                var border = {
                    minx: this.gameServer.border.minx - ran,
                    miny: this.gameServer.border.miny - ran,
                    maxx: this.gameServer.border.maxx + ran,
                    maxy: this.gameServer.border.maxy + ran
                };
                this.socket.sendPacket(new Packet.SetBorder(this, border));
            }
        }
    } else if (isDualMinion) {
        // Dual minion - just reset state, no packets needed
        this.clientNodes = [];
        // this.scramble(); // DISABLED: Consistency
        Logger.debug('[JOIN] Dual minion spawning: ' + name);
    }

    // ACTUALLY SPAWN THE PLAYER - this is where the magic happens
    Logger.info('[JOIN] Calling gameMode.onPlayerSpawn for PID=' + this.pID);
    this.gameServer.gameMode.onPlayerSpawn(this.gameServer, this);
    this.updateMass();
    Logger.info('[JOIN] After onPlayerSpawn - cells=' + this.cells.length);

    // Start active play tracking - time to grind XP (only for real players)
    if (!isDualMinion) {
        this.startActivePlay();

        // Start AFK checking
        this.startAFKCheck();
    }

    // Reset AFK timer on spawn
    this.lastActionTime = Date.now();
    this.afkWarned = false;

    // Broadcast updated player info to ALL Vanis clients on spawn/respawn
    // This is critical - all clients need to know about this player
    try {
        var clients = this.gameServer.clients;
        for (var i = 0; i < clients.length; i++) {
            var client = clients[i];
            if (client && client.packetHandler && client.packetHandler.isVanis && client.isConnected) {
                if (typeof client.packetHandler.sendVanisPlayerInfo === 'function') {
                    client.packetHandler.sendVanisPlayerInfo(this);
                }
            }
        }
        Logger.debug('[JOIN] Broadcast player info to ' + clients.length + ' clients');
    } catch (e) {
        Logger.debug('[JOIN] Broadcast error: ' + e.message);
    }

    // Send spawn confirmation (only for real sockets)
    if (!isDualMinion && isVanis && this.cells.length > 0) {
        var VanisWriter = require('./packet/VanisWriter');
        var confirm = new VanisWriter();
        //confirm.writeUInt8(0x12); // Spawn confirm opcode
        this.socket.send(confirm.finalize());
        Logger.debug('[JOIN] Sent spawn confirm packet to Vanis client');
    }

    Logger.info('[JOIN] ✅ Player spawned: "' + name + '" with ' + this.cells.length + ' cells (context=' + spawnContext + ')');
};

// =====================================
// CONNECTION CHECK - Are you alive n igger or nigga idk maybe nigga ok whatever i'll call super duper niggar?
// =====================================

PlayerTracker.prototype.checkConnection = function () {
    // Track spectate state changes (player is spectating when they have no cells but are connected)
    var isSpectating = (this.cells.length === 0 && this.socket.isConnected);

    // ALWAYS save death position when player dies (cells become 0)
    // This runs OUTSIDE of isCurrentlyPlaying check to catch ALL deaths
    // Only save if we don't already have a death position (prevents overwriting with stale centerPos)
    if (isSpectating && !this.lastDeathPosition && this.centerPos && (this.centerPos.x !== 0 || this.centerPos.y !== 0)) {
        this.lastDeathPosition = {
            x: this.centerPos.x,
            y: this.centerPos.y
        };

        // Comprehensive death position logging
        var border = this.gameServer.border;
        var deathInBounds = (
            this.centerPos.x >= border.minx &&
            this.centerPos.x <= border.maxx &&
            this.centerPos.y >= border.miny &&
            this.centerPos.y <= border.maxy
        );

        Logger.info('[NEAR-SPAWN-DEATH-DEBUG] ========================================');
        Logger.info('[NEAR-SPAWN-DEATH-DEBUG] DEATH RECORDED for PID=' + this.pID);
        Logger.info('[NEAR-SPAWN-DEATH-DEBUG] PlayerType: ' + (this.playerType || 'MAIN'));
        Logger.info('[NEAR-SPAWN-DEATH-DEBUG] Death Position: (' + Math.floor(this.centerPos.x) + ', ' + Math.floor(this.centerPos.y) + ')');
        Logger.info('[NEAR-SPAWN-DEATH-DEBUG] Current Border: [' + Math.floor(border.minx) + ', ' + Math.floor(border.maxx) + '] x [' + Math.floor(border.miny) + ', ' + Math.floor(border.maxy) + ']');
        Logger.info('[NEAR-SPAWN-DEATH-DEBUG] Border Size: ' + Math.floor(border.width) + 'x' + Math.floor(border.height));
        Logger.info('[NEAR-SPAWN-DEATH-DEBUG] Death Inside Border: ' + deathInBounds);
        if (!deathInBounds) {
            Logger.warn('[NEAR-SPAWN-DEATH-DEBUG]   Death position is OUTSIDE current border!');
            Logger.warn('[NEAR-SPAWN-DEATH-DEBUG]   If map shrinks before respawn, near-death spawn will be clamped.');
        }

        // Check if has partner (dual or owner)
        if (this.dualPlayer && this.dualPlayer.cells.length > 0) {
            var dualPos = this.dualPlayer.cells[0].position;
            var distToDual = Math.sqrt(
                Math.pow(this.centerPos.x - dualPos.x, 2) +
                Math.pow(this.centerPos.y - dualPos.y, 2)
            );
            Logger.info('[NEAR-SPAWN-DEATH-DEBUG] Has DUAL with cells at (' + Math.floor(dualPos.x) + ', ' + Math.floor(dualPos.y) + '), dist=' + Math.floor(distToDual));
        } else if (this.ownerPlayer && this.ownerPlayer.cells.length > 0) {
            var ownerPos = this.ownerPlayer.cells[0].position;
            var distToOwner = Math.sqrt(
                Math.pow(this.centerPos.x - ownerPos.x, 2) +
                Math.pow(this.centerPos.y - ownerPos.y, 2)
            );
            Logger.info('[NEAR-SPAWN-DEATH-DEBUG] Has OWNER with cells at (' + Math.floor(ownerPos.x) + ', ' + Math.floor(ownerPos.y) + '), dist=' + Math.floor(distToOwner));
        }
        Logger.info('[NEAR-SPAWN-DEATH-DEBUG] ========================================');
    } else if (isSpectating && this.lastDeathPosition) {
        // Log if death position already exists (happens on subsequent ticks after death)
        // Only log once per second to avoid spam
        if (this.gameServer.tickCounter % 25 === 0) {
            // Commented: Logger.debug('[DEATH-POS] Keeping existing death pos for PID=' + this.pID);
        }
    } else if (isSpectating && !this.lastDeathPosition) {
        // Player is spectating but no death position - this means centerPos was 0,0
        // This can happen if player disconnected at origin or never had cells
        if (this.gameServer.tickCounter % 250 === 0) { // Only log every 10 seconds
            Logger.debug('[NEAR-SPAWN-DEATH-DEBUG] PID=' + this.pID + ' spectating with no death pos (centerPos was 0,0 or null)');
        }
    }

    // Check if spectate state changed - player just died
    if (isSpectating && this.isCurrentlyPlaying) {
        // Player just died - STOP eject macro immediately!
        // No more remember ejecting when you're fucking dead
        this.ejectMacro = false;

        // Player just died - stop active play tracking
        this.stopActivePlay();

        // Start respawn cooldown for tournament mode and notify client
        if (this.gameServer.tournamentManager && this.gameServer.tournamentManager.isActive) {
            var tm = this.gameServer.tournamentManager;
            Logger.info('[TOURNAMENT] Main player death detected. roundStarted=' + tm.roundStarted + ' isFrozen=' + tm.isFrozen + ' discordId=' + this.discordId);

            if (this.discordId && tm.roundStarted && !tm.isFrozen) {
                tm.startRespawnCooldown(this.discordId);
                Logger.info('[TOURNAMENT] Main respawn cooldown started: ' + tm.respawnCooldownDuration + 's');

                // Send cooldown notification to client immediately (main player)
                if (this.socket && this.socket.packetHandler) {
                    this.socket.packetHandler.sendRespawnCooldown(tm.respawnCooldownDuration, false);
                    Logger.info('[TOURNAMENT] Sent main respawn cooldown packet to client');
                } else {
                    Logger.warn('[TOURNAMENT] Could not send cooldown packet - no packetHandler');
                }
            }
        }
    }

    // ALSO stop eject macro for dual player if they died
    // Because i want it like that
    if (this.dualPlayer && this.dualPlayer.cells.length === 0 && this.dualPlayer.ejectMacro) {
        this.dualPlayer.ejectMacro = false;
        Logger.debug('[EJECT-MACRO] Stopped dual player eject macro - dual is dead');
    }

    // Check if dual player just died (was alive, now dead)
    if (this.dualPlayer) {
        var dualWasAlive = this._dualWasAlive || false;
        var dualIsAlive = this.dualPlayer.cells && this.dualPlayer.cells.length > 0;

        if (dualWasAlive && !dualIsAlive) {
            // Dual just died - start respawn cooldown
            Logger.info('[TOURNAMENT] Dual player death detected. discordId=' + this.discordId);

            if (this.gameServer.tournamentManager && this.gameServer.tournamentManager.isActive) {
                var tm = this.gameServer.tournamentManager;
                if (this.discordId && tm.roundStarted && !tm.isFrozen) {
                    tm.startRespawnCooldown(this.discordId);
                    Logger.info('[TOURNAMENT] Dual respawn cooldown started: ' + tm.respawnCooldownDuration + 's');

                    // Send cooldown notification to client (main player's socket, isDual=true)
                    if (this.socket && this.socket.packetHandler) {
                        this.socket.packetHandler.sendRespawnCooldown(tm.respawnCooldownDuration, true);
                        Logger.info('[TOURNAMENT] Sent dual respawn cooldown packet to client');
                    }
                }
            }
        }

        this._dualWasAlive = dualIsAlive;
    }

    if (!this.socket.isConnected) {
        var dt = (this.gameServer.stepDateTime - this.socket.closeTime) / 1000;
        if (!this.cells.length || dt >= this.gameServer.config.playerDisconnectTime) {
            // Remove all cells
            while (this.cells.length > 0) {
                this.gameServer.removeNode(this.cells[0]);
            }

            // Stop active play tracking
            this.stopActivePlay();

            // Stop perks refresh interval on disconnect
            if (this.perksRefreshInterval) {
                clearInterval(this.perksRefreshInterval);
                this.perksRefreshInterval = null;
            }

            // Calculate and add session time XP
            var timeXP = this.calculateSessionTimeXP();
            if (timeXP.totalXP > 0) {
                this.sessionXP += timeXP.totalXP;
                this.sessionSeasonXP += timeXP.seasonXP;
                var activeMinutes = this.getActivePlayTimeMinutes();
                Logger.debug('[SESSION-XP] Player ' + this.pID + ' earned ' + timeXP.totalXP + ' total XP and ' + timeXP.seasonXP + ' season XP for ' + activeMinutes + ' active minutes played');
            }

            // Stop AFK checking
            this.stopAFKCheck();

            // Save session data to API before removing player
            this.saveSessionToAPI();

            this.isRemoved = true;
            return;
        }
        this.mouse.x = this.centerPos.x;
        this.mouse.y = this.centerPos.y;
        if (this.socket.packetHandler) {
            this.socket.packetHandler.pressSpace = false;
            this.socket.packetHandler.pressQ = false;
            this.socket.packetHandler.pressW = false;
        }
        this.minionControl = false;
        return;
    }

    // Check timeout
    if (!this.isCloseRequested && this.gameServer.config.serverTimeout) {
        var dt = (this.gameServer.stepDateTime - this.socket.lastAliveTime) / 1000;
        if (dt >= this.gameServer.config.serverTimeout) {
            this.socket.close(1000, "Connection timeout");
            this.isCloseRequested = true;
        }
    }
};

// =====================================
// VIEW STATE - What are we looking at a nigga??
// =====================================

PlayerTracker.prototype.getViewState = function () {
    if (!this.spectate) {
        return 0; // in game
    } else {
        if (this.freeRoam || this.getSpectateTarget() == null) {
            return 1; // free roam
        } else {
            return 2; // spectate target
        }
    }
};

// =====================================
// UPDATE TICK - my nigger here
// =====================================

PlayerTracker.prototype.updateTick = function () {
    // Allow DUAL_MINION to update even though it's technically a minion
    if (this.isRemoved || (this.isMinion && this.playerType !== 'DUAL_MINION')) return;

    // Profiler tracking
    var dp = this.gameServer.detailedProfiler;
    if (dp) {
        dp.updateTickCalls++;
        if (this.spectate) dp.spectatorCount++;
    }

    if (this.socket.packetHandler) {
        this.socket.packetHandler.process();
    }

    if (this.isMi) return;

    // Clear lastDeathPosition if player has successfully survived for a while
    // This allows the NEXT death to be recorded as the new death position
    // If we don't clear this, it sticks to the first death position of the session!
    if (this.cells.length > 0 && this.lastDeathPosition && this.activePlayStartTime > 0) {
        var timeAlive = Date.now() - this.activePlayStartTime;
        if (timeAlive > 5000) { // 5 seconds survival
            this.lastDeathPosition = null;
            Logger.debug('[DEATH-POS] Cleared old death position for PID=' + this.pID + ' (survived 5s)');
        }
    }

    // Apply snapping EVERY TICK while linelock is active
    // This ensures the snap direction stays correct as the root cell moves (root cell is the main cell btw but it only has one cell)
    // Without this, snap is only calculated once and becomes stale/diagonal
    if (this.isLineLocked &&
        this.useMouseProjectionCollision &&
        this.socket &&
        this.socket.packetHandler &&
        typeof this.socket.packetHandler._maybeSnapMouseForLineLock === 'function') {
        try {
            this.socket.packetHandler._maybeSnapMouseForLineLock(this);
        } catch (err) {
            // Snap update failed - not critical
        }
    }

    // Check for auto-respawn (if player just died)
    // Dual minions ALWAYS auto respawn - they need to stay in the game
    // Main player with a living dual should also auto respawn (keep the pair together)
    var autoRespawnEnabled = this.gameServer.config.playerAutoRespawn;
    var forceAutoRespawn = !!this.gameServer.config.forceAutoRespawn;
    var dualMinionOverride = (this.playerType === 'DUAL_MINION');
    var hasLivingDualPartner = false;

    // Check if this player has a living dual partner (for main player)
    if (this.playerType === 'REGULAR' && this.dualPlayer && this.dualPlayer.cells.length > 0) {
        hasLivingDualPartner = true;
    }
    // Check if owner is alive (for dual minion)
    if (this.playerType === 'DUAL_MINION' && this.ownerPlayer && this.ownerPlayer.cells.length > 0) {
        hasLivingDualPartner = true;
    }

    if (dualMinionOverride) {
        autoRespawnEnabled = true;
    }
    if (forceAutoRespawn) {
        autoRespawnEnabled = true;
    }
    // IMPORTANT: If you have a living dual partner, auto respawn to stay together
    if (hasLivingDualPartner) {
        autoRespawnEnabled = true;
    }

    // Track dual deaths while inactive - "hey, your dual keeps dying and you're not even watching"
    // Reset the death counted flag when player has cells (is alive)
    if (dualMinionOverride && this.cells.length > 0) {
        this._deathAlreadyCounted = false;
    }

    // This runs when dual just died and is about to auto-respawn
    if (dualMinionOverride && this.cells.length === 0 && this.ownerPlayer && !this.autoRespawnTimer) {
        var owner = this.ownerPlayer;

        // Skip death tracking if minion control is active - dual is being controlled via owner's inputs
        // No point counting deaths when user is literally driving the dual with their mouse
        if (owner.minionControlActive) {
            // Minion control = we're controlling dual, reset any existing death counter
            if (this.dualDeathsWhileInactive > 0 || this.dualRespawnBlocked) {
                Logger.debug('[DUAL-DEATH] ✅ Minion control active - resetting death counter');
                this.dualDeathsWhileInactive = 0;
                this.dualRespawnBlocked = false;
            }
        }
        // Only count this death once per death event
        else if (!this._deathAlreadyCounted && this.lastSpawnName) {
            this._deathAlreadyCounted = true; // Mark as counted so we don't count again

            // We're NOT being controlled when owner.isDualActive is FALSE
            if (!owner.isDualActive) {
                this.dualDeathsWhileInactive++;
                Logger.info('[DUAL-DEATH]  Dual PID=' + this.pID + ' died while inactive. Deaths: ' +
                    this.dualDeathsWhileInactive + '/3');

                // If died 3+ times while inactive, block auto-respawn
                if (this.dualDeathsWhileInactive >= 3 && !this.dualRespawnBlocked) {
                    this.dualRespawnBlocked = true;
                    Logger.info('[DUAL-DEATH]  Dual PID=' + this.pID +
                        ' respawn BLOCKED after ' + this.dualDeathsWhileInactive +
                        ' deaths while inactive. Tab switch to unblock.');

                    // Send chat message to owner so they know wtf is happening
                    if (this.gameServer && typeof this.gameServer.sendChatMessage === 'function') {
                        this.gameServer.sendChatMessage(null, owner,
                            "⚠️ Dual respawn blocked (died " + this.dualDeathsWhileInactive +
                            "x while inactive). Tab switch to resume.");
                    }
                }
            } else {
                // User is controlling dual, reset counter - they're paying attention
                if (this.dualDeathsWhileInactive > 0) {
                    Logger.debug('[DUAL-DEATH] ✅ Dual died while ACTIVE - resetting counter');
                    this.dualDeathsWhileInactive = 0;
                    this.dualRespawnBlocked = false;
                }
            }
        }
    }

    // BUT WAIT - if dual player died too many times while inactive, fuck that noise
    // Don't waste server resources respawning a dual that keeps feeding
    // EXCEPT: if minion control is active, user is controlling dual so let it respawn
    var minionControlIsActive = this.ownerPlayer && this.ownerPlayer.minionControlActive;
    if (dualMinionOverride && this.dualRespawnBlocked && !minionControlIsActive) {
        Logger.debug('[AUTO-RESPAWN]  Blocked for dual PID=' + this.pID +
            ' - died ' + this.dualDeathsWhileInactive + 'x while inactive. Tab switch to unblock.');
        autoRespawnEnabled = false;
    }

    // =====================================
    // MAIN PLAYER DEATH TRACKING (when dual is active)
    // Same logic as dual death tracking but for main player
    // If main keeps dying while user controls dual, block main respawn
    // =====================================
    var isMainPlayer = (this.playerType === 'REGULAR' && this.dualPlayer);

    // Reset flag when main player has cells (is alive)
    if (isMainPlayer && this.cells.length > 0) {
        this._mainDeathAlreadyCounted = false;
    }

    // Track main player deaths while controlling dual
    if (isMainPlayer && this.cells.length === 0 && this.dualPlayer && !this.autoRespawnTimer) {
        // Skip death tracking if minion control is active - user is controlling BOTH
        if (this.minionControlActive) {
            // Minion control = we're controlling both, reset any existing death counter
            if (this.mainDeathsWhileInactive > 0 || this.mainRespawnBlocked) {
                Logger.debug('[MAIN-DEATH] ✅ Minion control active - resetting main death counter');
                this.mainDeathsWhileInactive = 0;
                this.mainRespawnBlocked = false;
            }
        }
        // Only count this death once per death event
        else if (!this._mainDeathAlreadyCounted && this.lastSpawnName) {
            this._mainDeathAlreadyCounted = true;

            // User is controlling dual when isDualActive is TRUE
            if (this.isDualActive) {
                // Main is inactive - count death
                this.mainDeathsWhileInactive++;
                Logger.info('[MAIN-DEATH]  Main PID=' + this.pID + ' died while inactive (controlling dual). Deaths: ' +
                    this.mainDeathsWhileInactive + '/3');

                if (this.mainDeathsWhileInactive >= 3 && !this.mainRespawnBlocked) {
                    this.mainRespawnBlocked = true;
                    Logger.info('[MAIN-DEATH]  Main PID=' + this.pID +
                        ' respawn BLOCKED after ' + this.mainDeathsWhileInactive +
                        ' deaths while inactive. Tab switch to unblock.');

                    if (this.gameServer && typeof this.gameServer.sendChatMessage === 'function') {
                        this.gameServer.sendChatMessage(null, this,
                            " Main respawn blocked (died " + this.mainDeathsWhileInactive +
                            "x while controlling dual). Tab switch to resume.");
                    }
                }
            } else {
                // User is controlling main - reset counter
                if (this.mainDeathsWhileInactive > 0) {
                    Logger.debug('[MAIN-DEATH] ✅ Main died while ACTIVE - resetting counter');
                    this.mainDeathsWhileInactive = 0;
                    this.mainRespawnBlocked = false;
                }
            }
        }
    }

    // Block main respawn if died too many times while inactive (symmetric with dual)
    if (isMainPlayer && this.mainRespawnBlocked && this.isDualActive && !this.minionControlActive) {
        Logger.debug('[AUTO-RESPAWN]  Blocked for main PID=' + this.pID +
            ' - died ' + this.mainDeathsWhileInactive + 'x while inactive. Tab switch to unblock.');
        autoRespawnEnabled = false;
    }

    // Auto respawn check
    // Spectate check bypassed if: forceAutoRespawn, dual minion, has living partner, or client wants auto respawn
    var canBypassSpectate = forceAutoRespawn || dualMinionOverride || hasLivingDualPartner || this.clientAutoRespawnEnabled;

    if (this.cells.length === 0 &&
        autoRespawnEnabled &&
        this.lastSpawnName &&
        !this.autoRespawnTimer &&
        (!this.spectate || canBypassSpectate) &&
        this.socket.isConnected &&
        (!this.gameServer.tournamentManager || !this.gameServer.tournamentManager.isRespawnBlocked(this))) {

        // TOURNAMENT: Check if team is full before scheduling dual auto-respawn
        var tm = this.gameServer.tournamentManager;
        if (dualMinionOverride && tm && tm.isActive) {
            var spawnError = tm.canPlayerSpawn(this, true); // true = isDual
            if (spawnError) {
                Logger.info('[AUTO-RESPAWN]  Dual auto-respawn BLOCKED (pre-schedule) - ' + spawnError);
                // Don't schedule respawn - team is full
                return;
            }
        }

        // Player has no cells but had spawned before - start auto-respawn
        Logger.info('[AUTO-RESPAWN]  Scheduling for player ' + this.pID + ' (isDual: ' + dualMinionOverride + ' hasLivingPartner: ' + hasLivingDualPartner + ' clientEnabled: ' + this.clientAutoRespawnEnabled + ')');
        this._scheduleImmediateAutoRespawn(forceAutoRespawn || dualMinionOverride || hasLivingDualPartner);
    }

    // Reset feeding flag at start of each tick
    this.isFeedingThisTick = false;

    // Set feeding flag if eject macro is active
    if (this.ejectMacro && this.cells.length > 0) {
        this.isFeedingThisTick = true;
    }

    // Check if projection has expired
    if (this.useMouseProjectionCollision && this.projectionActiveUntilTick > 0) {
        if (this.gameServer.tickCounter > this.projectionActiveUntilTick) {
            Logger.debug('[PROJECTION]  Disabled for PID=' + this.pID +
                ' reason=PROJECTION_TIMEOUT' +
                ' currentTick=' + this.gameServer.tickCounter);
            this.useMouseProjectionCollision = false;
            this.isLineLocked = false;
            this.specialLineSplitLockActive = false;
            this.needsProjectionReactivation = true;
            this.projectionActiveUntilTick = 0;

            // Clear root markings
            for (var i = 0; i < this.cells.length; i++) {
                if (this.cells[i]) {
                    this.cells[i].isRootCell = false;
                    this.cells[i].rootCellId = 0;
                }
            }
        }
    }

    // Process split queue (fuck split64, doublesplit, etc)
    if (this.splitAttempts > 0 && this.cells.length > 0) {
        var maxCells = this.gameServer.config.playerMaxCells || 16;

        // Hit max cells? Queue is useless now, fuck it nigga
        if (this.cells.length >= maxCells) {
            this.splitAttempts = 0;
            this.splitAttemptsInitial = 0;
        } else {
            var baseDecay = this.gameServer.config.playerSplitQueueDecay || 5;
            var splitCap = this.gameServer.config.playerSplitCap || 4;

            // Use stored initial queue size for decay calculation
            var initialQueueSize = this.splitAttemptsInitial || this.splitAttempts;
            var dynamicDecay = Math.max(baseDecay, Math.ceil(initialQueueSize / splitCap) + baseDecay);
            var ticksSinceInput = this.gameServer.tickCounter - this.splitAttemptsTick;

            if (ticksSinceInput > dynamicDecay) {
                // User stopped pressing long enough, clear remaining queue
                this.splitAttempts = 0;
                this.splitAttemptsInitial = 0;
            } else {
                // Process queued splits with cap per tick
                var splitsToProcess = Math.min(this.splitAttempts, splitCap);

                for (var i = 0; i < splitsToProcess; i++) {
                    // Check max cells before each split - don't waste cycles
                    if (this.cells.length >= maxCells) {
                        this.splitAttempts = 0;
                        this.splitAttemptsInitial = 0;
                        break;
                    }
                    this.pressSpace();
                    this.splitAttempts--;
                }

                // Clear initial tracker when queue is empty
                if (this.splitAttempts <= 0) {
                    this.splitAttemptsInitial = 0;
                }
            }
        }
    } else if (this.splitAttempts > 0) {
        // No cells but have queued splits - instant decay
        this.splitAttempts = 0;
        this.splitAttemptsInitial = 0;
    }

    // Process eject macro 
    if (this.ejectMacro && this.cells.length > 0) {
        this.pressW();
    }

    // Update center based on view state
    switch (this.getViewState()) {
        case 0:
            this.updateCenterInGame();
            break;
        case 1:
            this.updateCenterFreeRoam();
            this._scale = this.gameServer.config.serverSpectatorScale;
            break;
        default:
            return;
    }

    // Update viewbox - i yoinked this from ogarx sorry )
    // formula: size = Math.max(factored_size, PLAYER_VIEW_MIN) * PLAYER_VIEW_SCALE
    var scale = Math.max(this.getScale(), this.gameServer.config.serverMinScale);
    var baseWidth = this.gameServer.config.serverViewBaseX / scale;
    var baseHeight = this.gameServer.config.serverViewBaseY / scale;

    // PLAYER_VIEW_MIN: Minimum viewport size (ensures you can see at least this much)
    var playerViewMin = this.gameServer.config.playerViewMin || 4000;
    // PLAYER_VIEW_SCALE: Viewport scale multiplier (1 = normal, 2 = 2x wider view)
    var playerViewScale = this.gameServer.config.playerViewScale || 1;

    //  formula: Math.max(calculated_size, PLAYER_VIEW_MIN) * PLAYER_VIEW_SCALE
    var halfWidth = Math.max(baseWidth / 2, playerViewMin / 2) * playerViewScale;
    var halfHeight = Math.max(baseHeight / 2, playerViewMin / 2) * playerViewScale;

    var minx = this.centerPos.x - halfWidth;
    var miny = this.centerPos.y - halfHeight;
    var maxx = this.centerPos.x + halfWidth;
    var maxy = this.centerPos.y + halfHeight;

    // Expand viewBox to ensure BOTH main and dual cells are always visible
    var expandViewBoxForCells = function (cells, margin) {
        for (var i = 0; i < cells.length; i++) {
            var cell = cells[i];
            if (!cell || cell.isRemoved) continue;
            var cellRadius = cell._size + margin;
            minx = Math.min(minx, cell.position.x - cellRadius);
            miny = Math.min(miny, cell.position.y - cellRadius);
            maxx = Math.max(maxx, cell.position.x + cellRadius);
            maxy = Math.max(maxy, cell.position.y + cellRadius);
        }
    };

    var expansionMargin = 200; // idk why i add this i have safety problems kill me god help me
    if (this.cells.length > 0) {
        expandViewBoxForCells(this.cells, expansionMargin);
    }
    // Include dual player's cells in the view
    if (this.dualPlayer && this.dualPlayer.cells.length > 0) {
        expandViewBoxForCells(this.dualPlayer.cells, expansionMargin);
    }

    this.viewBox = {
        minx: minx,
        miny: miny,
        maxx: maxx,
        maxy: maxy,
        halfWidth: (maxx - minx) / 2,
        halfHeight: (maxy - miny) / 2
    };

    // Update visible nodes (Luka's simplified approach)
    this.viewNodes = [];
    var self = this;

    // Use quad-tree finder if available (Luka's method)
    var ejectHideDelay = this.gameServer.config.ejectHideDelay;
    var skipHideDelay = this.spectate || this.freeRoam;

    this.gameServer.finder.find(this.viewBox, function (quadItem) {
        if (quadItem.cell.owner != self) {
            var cell = quadItem.cell;
            // ejectHideDelay logic
            if (!skipHideDelay && ejectHideDelay > 0 && cell.cellType === 3) {
                var parentAge = cell.parentCellAge;
                if (parentAge !== undefined && parentAge < ejectHideDelay) {
                    var ejectAge = cell.getAge();
                    if (ejectAge < ejectHideDelay) {
                        return; // Hide - ejected from young cell
                    }
                }
            }
            self.viewNodes.push(quadItem.cell);
        }
    });

    // Add own cells
    this.viewNodes = this.viewNodes.concat(this.cells);

    // Add dual player's cells (extension for dual mode)
    if (this.dualPlayer && this.dualPlayer.cells.length > 0) {
        for (var d = 0; d < this.dualPlayer.cells.length; d++) {
            var dualCell = this.dualPlayer.cells[d];
            if (dualCell && !dualCell.isRemoved) {
                this.viewNodes.push(dualCell);
            }
        }
    }

    // Sort viewNodes by nodeId for Luka's sorted merge diff algorithm
    this.viewNodes.sort(function (a, b) { return a.nodeId - b.nodeId; });

    // Profiler tracking - viewport stats
    var dp = this.gameServer.detailedProfiler;
    if (dp) {
        dp.viewportQueries++;
        dp.viewNodesTotal += this.viewNodes.length;
    }
};

// =====================================
// SEND UPDATE - Push data to client
// =====================================

PlayerTracker.prototype.sendUpdate = function () {
    // Early exit tracking for profiler
    var dp = this.gameServer.detailedProfiler;

    if (this.isRemoved || !this.socket.packetHandler || !this.socket.packetHandler.protocol ||
        !this.socket.isConnected || this.isMi || this.isMinion ||
        (this.socket._socket.writable != null && !this.socket._socket.writable) ||
        this.socket.readyState != this.socket.OPEN) {
        // Track skip reasons
        if (dp) {
            dp.sendUpdateSkips = (dp.sendUpdateSkips || 0) + 1;
            if (this.isRemoved) dp.skipRemoved = (dp.skipRemoved || 0) + 1;
            else if (!this.socket.packetHandler) dp.skipNoHandler = (dp.skipNoHandler || 0) + 1;
            else if (!this.socket.packetHandler.protocol) dp.skipNoProtocol = (dp.skipNoProtocol || 0) + 1;
            else if (!this.socket.isConnected) dp.skipNotConnected = (dp.skipNotConnected || 0) + 1;
            else if (this.isMi) dp.skipMi = (dp.skipMi || 0) + 1;
            else if (this.isMinion) dp.skipMinion = (dp.skipMinion || 0) + 1;
            else if (this.socket._socket.writable != null && !this.socket._socket.writable) dp.skipNotWritable = (dp.skipNotWritable || 0) + 1;
            else if (this.socket.readyState != this.socket.OPEN) dp.skipNotOpen = (dp.skipNotOpen || 0) + 1;
        }
        return;
    }

    // Profiler tracking - only if we passed all checks
    if (dp) dp.clientUpdates++;

    var v = this.getViewState();
    if (v !== 0) {
        if (v === 2) {
            var player = this.getSpectateTarget();
            if (player) {
                this.setCenterPos(player.centerPos.x, player.centerPos.y);
                this._scale = player.getScale();
                this.viewBox = player.viewBox;
                this.viewNodes = player.viewNodes;
            }
        }

        // Send camera position
        if (this.socket.packetHandler.isVanis) {
            this.socket.packetHandler.sendVanisCameraPosition(this.centerPos.x, this.centerPos.y);
        } else {
            this.socket.sendPacket(new Packet.UpdatePosition(
                this, this.centerPos.x, this.centerPos.y, this.getScale()
            ));
        }
    }

    if (this.gameServer.config.serverScrambleLevel == 2) {
        if (!this.borderCounter) {
            var b = this.gameServer.border, v = this.viewBox;
            var bound = {
                minx: Math.max(b.minx, v.minx - v.halfWidth),
                miny: Math.max(b.miny, v.miny - v.halfHeight),
                maxx: Math.min(b.maxx, v.maxx + v.halfWidth),
                maxy: Math.min(b.maxy, v.maxy + v.halfHeight)
            };
            this.socket.sendPacket(new Packet.SetBorder(this, bound));
        }
        this.borderCounter++;
        if (this.borderCounter >= 20) this.borderCounter = 0;
    }

    // Calculate node changes
    var delNodes = [];
    var eatNodes = [];
    var addNodes = [];
    var updNodes = [];
    var oldIndex = 0;
    var newIndex = 0;

    // Luka's sorted merge diff algorithm (requires sorted arrays by nodeId)
    for (; newIndex < this.viewNodes.length && oldIndex < this.clientNodes.length;) {
        if (this.viewNodes[newIndex].nodeId < this.clientNodes[oldIndex].nodeId) {
            addNodes.push(this.viewNodes[newIndex]);
            newIndex++;
            continue;
        }
        if (this.viewNodes[newIndex].nodeId > this.clientNodes[oldIndex].nodeId) {
            var node = this.clientNodes[oldIndex];
            if (node.isRemoved && node.killedBy !== null)
                eatNodes.push(node);
            else
                delNodes.push(node);
            oldIndex++;
            continue;
        }
        var node = this.viewNodes[newIndex];
        // skip food & eject if not moving (Luka's original optimization)
        if (node.isMoving || (node.cellType != 1 && node.cellType != 3))
            updNodes.push(node);
        newIndex++;
        oldIndex++;
    }
    for (; newIndex < this.viewNodes.length;) {
        addNodes.push(this.viewNodes[newIndex]);
        newIndex++;
    }
    for (; oldIndex < this.clientNodes.length;) {
        var node = this.clientNodes[oldIndex];
        if (node.isRemoved && node.killedBy !== null)
            eatNodes.push(node);
        else
            delNodes.push(node);
        oldIndex++;
    }

    this.clientNodes = this.viewNodes;

    // Filter out invisible foods if config is enabled
    // Foods still exist and can be eaten, just not visible to clients
    if (this.gameServer.config.invisibleFoods) {
        addNodes = addNodes.filter(function (node) { return node.cellType !== 1; });
        updNodes = updNodes.filter(function (node) { return node.cellType !== 1; });
        // Don't filter delNodes - we want food to "disappear" when eaten
    }

    // Send packet based on client type
    var dp = this.gameServer.detailedProfiler;
    if (this.socket.isConnected != null) {
        if (dp) dp.isConnectedPassed = (dp.isConnectedPassed || 0) + 1;

        if (this.socket.packetHandler.isVanis) {
            if (dp) dp.isVanisPassed = (dp.isVanisPassed || 0) + 1;

            // Vanis protocol
            this.socket.packetHandler.sendVanisWorldUpdate(addNodes, updNodes, eatNodes, delNodes);
            this.socket.packetHandler.sendVanisOwnedCellCount();

            // Leaderboard every 10 ticks (reduced from 4 for bandwidth because i dont care)
            if ((this.gameServer.tickCounter % 10) === 0) {
                this.socket.packetHandler.sendVanisLeaderboard();
            }

            // Minimap every 10 ticks (reduced from 5 for bandwidth because i dont care)
            if ((this.gameServer.tickCounter % 10) === 5) {
                this.socket.packetHandler.sendVanisMinimap();
            }
        } else {
            if (dp) dp.legacyProtocolUsed = (dp.legacyProtocolUsed || 0) + 1;

            // Legacy protocol because i dont care this aswell
            this.socket.sendPacket(new Packet.UpdateNodes(
                this, addNodes, updNodes, eatNodes, delNodes
            ));
            this.sendLeaderboard();
        }
    } else {
        if (dp) dp.isConnectedFailed = (dp.isConnectedFailed || 0) + 1;
    }
};

PlayerTracker.prototype.sendLeaderboard = function () {
    if (this.gameServer.leaderboardChanged) {
        var lbType = this.gameServer.leaderboardType,
            lbList = this.gameServer.leaderboard;

        if (lbType >= 0) {
            // Profiler tracking
            var dp = this.gameServer.detailedProfiler;
            if (dp) dp.leaderboardSends++;

            if (this.socket.packetHandler.protocol >= 11 && this.gameServer.gameMode.specByLeaderboard)
                this.socket.sendPacket(new Packet.LeaderboardPosition(this, lbList.indexOf(this) + 1));
            this.socket.sendPacket(new Packet.UpdateLeaderboard(this, lbList, lbType));
        }
    }
};

// =====================================
// CENTER UPDATES - Where's the camera?
// =====================================

PlayerTracker.prototype.updateCenterInGame = function () {
    // Always build the camera from BOTH trackers so switching control doesn't move the camera
    // actually rest of those functions are garbage and i feel like dumb why i did this
    var trackers = [];
    if (this.cells.length > 0) trackers.push(this);
    if (this.dualPlayer && this.dualPlayer.cells.length > 0) trackers.push(this.dualPlayer);

    if (trackers.length === 0) {
        // No cells alive on either tracker – hold position using last known center
        var fallback = this.lastKnownCenter || this.mouse;
        if (fallback) {
            this.centerPos.x = fallback.x || 0;
            this.centerPos.y = fallback.y || 0;
        } else {
            // Find largest player to follow (spectator)
            var largest = this.gameServer.largestClient;
            if (largest && largest.cells.length > 0) {
                var cx = 0, cy = 0;
                for (var i = 0; i < largest.cells.length; i++) {
                    if (largest.cells[i]) {
                        cx += largest.cells[i].position.x;
                        cy += largest.cells[i].position.y;
                    }
                }
                this.centerPos.x = cx / largest.cells.length;
                this.centerPos.y = cy / largest.cells.length;
            } else {
                this.centerPos.x = this.mouse.x || 0;
                this.centerPos.y = this.mouse.y || 0;
            }
        }
        return;
    }

    // Calculate weighted center from all trackers (main + dual)
    var combinedMass = 0;
    var combinedCenterX = 0;
    var combinedCenterY = 0;

    for (var t = 0; t < trackers.length; t++) {
        var tracker = trackers[t];
        for (var i = 0; i < tracker.cells.length; i++) {
            var cell = tracker.cells[i];
            if (!cell || cell.isRemoved) continue;
            var mass = cell._mass;
            combinedCenterX += cell.position.x * mass;
            combinedCenterY += cell.position.y * mass;
            combinedMass += mass;
        }
    }

    if (combinedMass > 0) {
        this.centerPos.x = combinedCenterX / combinedMass;
        this.centerPos.y = combinedCenterY / combinedMass;
    }

    // Save for later use when dead
    this.lastKnownCenter = { x: this.centerPos.x, y: this.centerPos.y };
};

PlayerTracker.prototype.updateCenterFreeRoam = function () {
    var dx = this.mouse.x - this.centerPos.x;
    var dy = this.mouse.y - this.centerPos.y;
    var speed = this.gameServer.config.serverFreeRoamSpeed || 32;
    var d = speed / Math.sqrt(dx * dx + dy * dy);
    if (!d) return;
    var x = this.centerPos.x + dx * d;
    var y = this.centerPos.y + dy * d;
    this.setCenterPos(x, y);
};

// =====================================
// CONTROLS - Split, eject, spectate toggle
// =====================================

PlayerTracker.prototype.pressSpace = function () {
    if (this.gameServer.run && this.cells.length > 0) {
        if (this.mergeOverride || this.frozen) return;

        // Update AFK timer - player is active
        this.updatePlayerAction('SPLIT');

        // Profiler tracking
        var dp = this.gameServer.detailedProfiler;
        if (dp) dp.splitCount++;

        this.gameServer.splitCells(this);
    }
};

PlayerTracker.prototype.pressW = function () {
    if (this.getViewState() !== 0) return;
    if (this.gameServer.run) {
        // Check for virus pop delay
        if (this.lastPop != undefined && this.gameServer.config.playerVirusPopDelay > 0) {
            if (this.gameServer.tickCounter - this.lastPop < this.gameServer.config.playerVirusPopDelay) {
                return;
            }
        }

        // Update AFK timer - player is active
        this.updatePlayerAction('EJECT');

        // Profiler tracking
        var dp = this.gameServer.detailedProfiler;
        if (dp) dp.ejectCount++;

        this.isFeedingThisTick = true; // Mark that player is feeding this tick
        this.gameServer.ejectMass(this);
    }
};

PlayerTracker.prototype.pressQ = function () {
    if (this.getViewState() !== 0) {
        var tick = this.gameServer.tickCounter;
        if (tick - this.lastKeypressTick < 40) return;
        this.lastKeypressTick = tick;
        this.freeRoam = !this.freeRoam;
    }
};

PlayerTracker.prototype.getSpectateTarget = function () {
    // If a specific player is being spectated, find and return them
    if (this.spectateTargetPid !== null) {
        for (var i = 0; i < this.gameServer.clients.length; i++) {
            var client = this.gameServer.clients[i];
            if (client && client.playerTracker &&
                client.playerTracker.pID === this.spectateTargetPid &&
                client.playerTracker.cells.length > 0) {
                return client.playerTracker;
            }
        }
        // Target has no cells - check if they're still connected
        // Keep the lock active if player exists (just dead, not disconnected)
        for (var i = 0; i < this.gameServer.clients.length; i++) {
            var client = this.gameServer.clients[i];
            if (client && client.playerTracker &&
                client.playerTracker.pID === this.spectateTargetPid) {
                // Player exists but dead - keep lock, return null to stay at current position
                return null;
            }
        }
        // Player actually disconnected - clear the lock (this is buggy btw)
        this.spectateTargetPid = null;
    }

    // Default: spectate largest player (this is also buggy)
    return this.gameServer.largestClient;
};

PlayerTracker.prototype.setCenterPos = function (x, y) {
    x = Math.max(x, this.gameServer.border.minx);
    y = Math.max(y, this.gameServer.border.miny);
    x = Math.min(x, this.gameServer.border.maxx);
    y = Math.min(y, this.gameServer.border.maxy);
    this.centerPos.x = x;
    this.centerPos.y = y;
};

// =====================================
// XP & ACCOUNT SYSTEM - Where the niggers fight for it
// =====================================

PlayerTracker.prototype.addXP = function (xpAmount, seasonXpAmount) {
    if (xpAmount <= 0) return;

    // Only award XP to players who are logged in with Discord (have discordToken)
    if (!this.discordToken) {
        return; // No token = no XP, sorry buddy
    }

    // If seasonXpAmount not provided, use xpAmount
    if (seasonXpAmount === undefined) {
        seasonXpAmount = xpAmount;
    }

    this.currentXP += xpAmount;
    this.seasonXP += seasonXpAmount;

    // Check for level up (simple formula: level = floor(sqrt(xp / 100)) + 1)
    var newLevel = Math.floor(Math.sqrt(this.currentXP / 100)) + 1;
    var leveledUp = newLevel > this.currentLevel;

    if (leveledUp) {
        this.currentLevel = newLevel;
        Logger.debug('[XP] Player ' + this.pID + ' leveled up to ' + newLevel + '!');
    }

    // Send XP update to client
    if (this.socket && this.socket.packetHandler && this.socket.packetHandler.isVanis) {
        this.socket.packetHandler.sendVanisXPUpdate(leveledUp, this.currentXP, this.currentLevel);
    }

    // Save to API periodically (not every XP gain, that would be insane)
    this._scheduleXPSave();
};

PlayerTracker.prototype._scheduleXPSave = function () {
    // Debounce XP saves to avoid hammering the API
    if (this._xpSaveTimeout) return;

    var self = this;
    this._xpSaveTimeout = setTimeout(function () {
        self._xpSaveTimeout = null;
        self._saveXPToAPI();
    }, 30000); // Save every 30 seconds max
};

PlayerTracker.prototype._saveXPToAPI = function () {
    if (!this.discordToken) return;

    var https = require('https');
    var postData = JSON.stringify({
        xp: this.currentXP,
        seasonXp: this.seasonXP
    });
    //hell yea api endpoints hack me nigga
    var options = {
        hostname: 'aetlis.io',
        port: 443,
        path: '/api/xp/update',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Vanis ' + this.discordToken,
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    var req = https.request(options, function (res) {
        // Silently handle response but you have to be silent or i'Ll kill this nigger
        res.on('data', function () { });
    });

    req.on('error', function (err) {
        Logger.debug('[XP] API save error: ' + err.message);
    });

    req.write(postData);
    req.end();
};

PlayerTracker.prototype.loadXPFromAPI = function (callback) {
    // Load current XP and level from API
    if (!this.discordToken) {
        if (callback) callback();
        return;
    }

    var https = require('https');
    var self = this;

    var options = {
        hostname: 'aetlis.io',
        port: 443,
        path: '/api/me',
        method: 'GET',
        headers: {
            'Authorization': 'Vanis ' + this.discordToken
        }
    };

    var req = https.request(options, function (res) {
        var data = '';

        res.on('data', function (chunk) {
            data += chunk;
        });

        res.on('end', function () {
            try {
                var userData = JSON.parse(data);

                // Store Discord ID for admin permission checks - this is crucial
                self.discordId = userData.discordId || userData.uid || null;

                // Update Discord name - API returns discord_name or discordName
                self.discordName = userData.discord_name || userData.discordName || null;
                Logger.debug('[XP] Discord name from API: ' + self.discordName + ' ID: ' + self.discordId);

                // ============================================
                // BAN CHECK - KICK IMMEDIATELY IF BANNED
                // This is the first thing we check after getting user data
                // ============================================
                if (userData.banned) {
                    Logger.warn('[BAN]  BANNED PLAYER DETECTED: ' + self.discordName + ' (' + self.discordId + ')');
                    Logger.warn('[BAN] Reason: ' + (userData.ban_reason || userData.message || 'No reason'));

                    // Send message to player before kicking
                    if (self.socket && self.socket.packetHandler) {
                        self.gameServer.sendChatMessage(null, self, ' You are BANNED: ' + (userData.ban_reason || 'Contact admin'));
                    }

                    // Kick player immediately
                    if (self.socket && self.socket.close) {
                        self.socket.close(1008, 'Banned: ' + (userData.ban_reason || 'Account banned'));
                    }

                    // Don't process anything else
                    if (callback) callback();
                    return;
                }

                // Update XP and level
                self.currentXP = userData.xp || 0;
                self.currentLevel = userData.level || 1;
                self.seasonXP = userData.seasonXp || 0;

                // Update muted status from API
                self.isMuted = userData.muted || false;
                if (self.isMuted) {
                    Logger.debug('[MUTE] Player is muted: ' + self.discordName + ' Reason: ' + (userData.muteReason || 'unknown'));
                }

                // Update admin level from API
                // CRITICAL: Also check for hardcoded full admin Discord ID
                var FULL_ADMIN_ID = '707227552627949639';
                if (self.discordId === FULL_ADMIN_ID) {
                    self.adminLevel = 2; // Full admin - can do anything
                    Logger.info('[ADMIN]  Admin connected: ' + self.discordName);
                } else {
                    self.adminLevel = userData.adminLevel || (userData.permissions ? 2 : 0);
                }
                Logger.debug('[ADMIN] Admin level for ' + self.discordName + ': ' + self.adminLevel);

                // Set referee status - check via API for referee role
                // Admins are always referees and teleporters
                if (self.adminLevel >= 1) {
                    self.isReferee = true;
                    self.isTeleporter = true;
                    Logger.info('[TOURNAMENT] Referee connected (admin): ' + self.discordName);
                } else {
                    // Check referee and teleporter roles via API
                    self._checkRefereeRoleAsync();
                    self._checkTeleporterRoleAsync();
                }

                // ============================================
                // TOURNAMENT MODE - CHECK IF PLAYER CAN PLAY
                // If this is a tournament server, verify player is registered
                // ============================================
                if (self.gameServer && self.gameServer.tournamentData && self.gameServer.tournamentData.enabled) {
                    if (!self.gameServer.isAllowedToSpawn(self.discordId)) {
                        Logger.info('[TOURNAMENT] 👀 Spectator-only player connected: ' + self.discordName + ' (' + self.discordId + ')');
                        self._tournamentSpawnBlocked = true;
                        self.spectate = true;
                        self.freeRoam = true;
                        self.gameServer.sendChatMessage(null, self, "Go to spectate mode. You are not registered for this match.");

                        // Send force spectate packet to client - automatically enter spectator mode
                        if (self.socket && self.socket.packetHandler && self.socket.packetHandler.sendVanisForceSpectate) {
                            self.socket.packetHandler.sendVanisForceSpectate();
                        }

                        // IMPORTANT: Broadcast player info so others can see spectator's name in chat
                        // Without this, spectator chat shows "Player #X" instead of their name
                        if (self.socket && self.socket.packetHandler && self.socket.packetHandler.broadcastPlayerInfo) {
                            self.socket.packetHandler.broadcastPlayerInfo(self);
                            Logger.debug('[TOURNAMENT] Broadcast spectator player info for chat visibility');
                        }
                    } else {
                        // REGISTERED PLAYER - unblock them!
                        Logger.info('[TOURNAMENT] ✅ Registered player connected: ' + self.discordName + ' (' + self.discordId + ')');
                        self._tournamentSpawnBlocked = false;
                        self._tournamentSpectateInitialized = false;

                        // Send AllowPlay packet to undo the initial ForceSpectate
                        if (self.socket && self.socket.packetHandler && self.socket.packetHandler.sendVanisAllowPlay) {
                            self.socket.packetHandler.sendVanisAllowPlay();
                            Logger.info('[TOURNAMENT] 🎮 Sent AllowPlay packet - player can spawn!');
                        }
                    }
                }

                // Sanitize & update name color from API
                var rawColor = userData.nameColor || null;
                var sanitizedColor = null;
                if (rawColor && typeof rawColor === 'string' && /^[0-9a-fA-F]{6}$/.test(rawColor)) {
                    sanitizedColor = rawColor.toUpperCase();
                }
                self.nameColor = sanitizedColor;
                self.nameColorEnabled = userData.nameColorEnabled || false;

                // Check if name matches perk_name_picked (if set)
                if (userData.perk_name_picked && userData.perk_name_picked.trim() !== "") {
                    self.lockedNameNormalized = self._normalizeNameForPerks(userData.perk_name_picked);
                    var currentName = self._normalizeNameForPerks(self._name || "");
                    var lockedName = self.lockedNameNormalized;
                    if (!currentName || currentName !== lockedName) {
                        // Name doesn't match, disable colored name
                        self.nameColorEnabled = false;
                        Logger.debug('[NAME-CHECK] Colored name disabled: player name does not match perk_name_picked');
                    }
                } else {
                    self.lockedNameNormalized = "";
                }

                // Update badge from API
                var badge = Number(userData.perk_badge_set || 0);
                self.badgeId = Math.max(0, Math.min(badge, 21));

                Logger.debug('[XP] Loaded from API for player ' + self.pID + ': Level ' + self.currentLevel + ' XP ' + self.currentXP + ' NameColor: ' + (self.nameColor || 'none'));

                // Send initial XP update to client
                if (self.socket && self.socket.packetHandler && self.socket.packetHandler.isVanis) {
                    self.socket.packetHandler.sendVanisXPUpdate(false, self.currentXP, self.currentLevel);
                }

                // Broadcast player info if perks changed
                var changed = (self._lastBroadcastNameColor !== self.nameColor) ||
                    (self._lastBroadcastBadgeId !== self.badgeId) ||
                    (self._lastBroadcastColorEnabled !== self.nameColorEnabled);
                if (changed && self.gameServer && self.gameServer.clients) {
                    self._lastBroadcastNameColor = self.nameColor;
                    self._lastBroadcastBadgeId = self.badgeId;
                    self._lastBroadcastColorEnabled = self.nameColorEnabled;
                    try {
                        for (var i = 0; i < self.gameServer.clients.length; i++) {
                            var client = self.gameServer.clients[i];
                            if (client && client.packetHandler && client.packetHandler.isVanis && client.isConnected) {
                                client.packetHandler.sendVanisPlayerInfo(self);
                            }
                        }
                    } catch (broadcastErr) {
                        Logger.debug('[PERKS] Broadcast error: ' + broadcastErr.message);
                    }
                }

                if (callback) callback();
            } catch (e) {
                Logger.debug('[XP] API parse error: ' + e.message);
                if (callback) callback();
            }
        });
    });

    req.on('error', function (err) {
        Logger.debug('[XP] API error: ' + err.message);
        if (callback) callback();
    });

    req.end();

    // Set up periodic refresh (every 5 minutes)
    if (!this.perksRefreshInterval) {
        var self = this;
        this.perksRefreshInterval = setInterval(function () {
            self.loadXPFromAPI();
        }, 300000);
    }
};

/**
 * Check referee role asynchronously via API
 * Called after user data is loaded if they're not already an admin
 */
PlayerTracker.prototype._checkRefereeRoleAsync = function () {
    if (!this.discordId) return;

    var self = this;
    var http = require('http');
    var https = require('https');

    // API URL - adjust to your setup
    var apiHost = process.env.API_HOST || 'aetlis.io';
    var apiPort = process.env.API_PORT || 443;
    var isHttps = apiPort === 443 || apiPort === '443';
    var lib = isHttps ? https : http;
    //tbh this endpoint is not needed but uhhhhhhhhhhhhhh why not
    var options = {
        hostname: apiHost,
        port: apiPort,
        path: '/api/tournament/check-referee/' + this.discordId,
        method: 'GET',
        timeout: 5000
    };

    var req = lib.request(options, function (res) {
        var data = '';
        res.on('data', function (chunk) { data += chunk; });
        res.on('end', function () {
            try {
                var result = JSON.parse(data);
                if (result.isReferee) {
                    self.isReferee = true;
                    Logger.info('[TOURNAMENT]  Referee role verified via API: ' + self.discordName);
                } else {
                    self.isReferee = false;
                }
            } catch (e) {
                Logger.debug('[TOURNAMENT] Referee check parse error: ' + e.message);
            }
        });
    });

    req.on('error', function (err) {
        Logger.debug('[TOURNAMENT] Referee API check failed: ' + err.message);
        // Default to false on error
        self.isReferee = false;
    });

    req.on('timeout', function () {
        Logger.debug('[TOURNAMENT] Referee API check timeout');
        req.destroy();
    });

    req.end();
};

/**
 * Check teleporter role asynchronously via API
 * Teleporter can only use /teleport in tournament servers
 */
PlayerTracker.prototype._checkTeleporterRoleAsync = function () {
    if (!this.discordId) return;

    var self = this;
    var http = require('http');
    var https = require('https');

    var apiHost = process.env.API_HOST || 'aetlis.io';
    var apiPort = process.env.API_PORT || 443;
    var isHttps = apiPort === 443 || apiPort === '443';
    var lib = isHttps ? https : http;
    //i'm dumb at this point why tf is this even needed
    var options = {
        hostname: apiHost,
        port: apiPort,
        path: '/api/tournament/check-teleporter/' + this.discordId,
        method: 'GET',
        timeout: 5000
    };

    var req = lib.request(options, function (res) {
        var data = '';
        res.on('data', function (chunk) { data += chunk; });
        res.on('end', function () {
            try {
                var result = JSON.parse(data);
                if (result.isTeleporter) {
                    self.isTeleporter = true;
                    Logger.info('[TOURNAMENT] Teleporter role verified: ' + self.discordName);
                } else {
                    self.isTeleporter = false;
                }
            } catch (e) {
                Logger.debug('[TOURNAMENT] Teleporter check parse error: ' + e.message);
            }
        });
    });

    req.on('error', function (err) {
        Logger.debug('[TOURNAMENT] Teleporter API check failed: ' + err.message);
        self.isTeleporter = false;
    });

    req.on('timeout', function () {
        Logger.debug('[TOURNAMENT] Teleporter API check timeout');
        req.destroy();
    });

    req.end();
};

PlayerTracker.prototype._normalizeNameForPerks = function (name) {
    if (!name) return "";
    // Strip skin tags
    var cleanName = name;
    if (cleanName[0] === '<') {
        var tagEnd = cleanName.indexOf('>');
        if (tagEnd >= 1) {
            cleanName = cleanName.slice(tagEnd + 1);
        }
    }
    return cleanName.trim().toLowerCase();
};

// =====================================
// TAG ISOLATION SYSTEM - tags
// =====================================

PlayerTracker.prototype.getNormalizedTag = function () {
    if (!this._tag) return '';
    return ('' + this._tag).trim().toLowerCase();
};

PlayerTracker.prototype.canSeePlayerByTag = function (target) {
    var myTag = this.getNormalizedTag();
    var targetTag = (target && typeof target.getNormalizedTag === 'function')
        ? target.getNormalizedTag()
        : (target && target._tag ? ('' + target._tag).trim().toLowerCase() : '');

    if (!myTag && !targetTag) {
        return true; // both untagged = can see each other
    }
    if (!myTag && targetTag) {
        return false; // untagged player can't see tagged player
    }
    if (myTag && !targetTag) {
        return false; // tagged player ignores untagged players
    }
    return myTag === targetTag; // same tag = can see each other
};

// XP coefficient based on level - higher levels get less XP per pellet
// This prevents high level players from farming indefinitely
PlayerTracker.prototype.getPelletXPCoefficient = function () {
    if (this.currentLevel <= 5) {
        return 0.40;    // New players gain more XP
    } else if (this.currentLevel <= 20) {
        return 0.195;   // Mid-level players
    } else if (this.currentLevel <= 50) {
        return 0.0975;  // High-level players gain less
    } else {
        return 0.05;    // Very high-level players (exponential slowdown)
    }
};

// =====================================
// ACTIVE PLAY TIME TRACKING
// Only counts time when actually playing, not spectating
// =====================================

PlayerTracker.prototype.startActivePlay = function () {
    // Start tracking active play time when player spawns
    if (!this.isCurrentlyPlaying) {
        this.activePlayStartTime = Date.now();
        this.isCurrentlyPlaying = true;
        Logger.debug('[ACTIVE-PLAY] Player ' + this.pID + ' started active play');
    }
};

PlayerTracker.prototype.stopActivePlay = function () {
    // Stop tracking active play time when player dies or spectates
    if (this.isCurrentlyPlaying && this.activePlayStartTime > 0) {
        var activeDuration = Date.now() - this.activePlayStartTime;
        this.totalActivePlayTime += activeDuration;
        this.isCurrentlyPlaying = false;
        this.activePlayStartTime = 0;

        var totalMinutes = Math.floor(this.totalActivePlayTime / 60000);
        Logger.debug('[ACTIVE-PLAY] Player ' + this.pID + ' stopped active play. Duration: ' + activeDuration + 'ms. Total: ' + totalMinutes + ' minutes');
    }
};

PlayerTracker.prototype.getActivePlayTimeMinutes = function () {
    // Get total active play time in minutes
    var totalTime = this.totalActivePlayTime;

    // Add current session if still playing
    if (this.isCurrentlyPlaying && this.activePlayStartTime > 0) {
        totalTime += (Date.now() - this.activePlayStartTime);
    }

    return Math.floor(totalTime / 60000);
};

PlayerTracker.prototype.calculateSessionTimeXP = function () {
    // Only calculate XP for players with Discord login
    if (!this.discordToken) {
        return { totalXP: 0, seasonXP: 0 };
    }

    // Calculate XP based on ACTIVE play time only
    var activePlayMinutes = this.getActivePlayTimeMinutes();

    // Must have at least 1 minute of active play
    if (activePlayMinutes < 1) {
        return { totalXP: 0, seasonXP: 0 };
    }

    // XP per minute calculation (configurable)
    var xpPerMinute = this.gameServer.config.sessionTimeXPPerMinute || 10;

    // Total XP: Uses level multiplier (rewards high-level players for time)
    var levelMultiplier = 1 + (this.currentLevel * 0.05); // 5% bonus per level
    var totalTimeXP = Math.floor(activePlayMinutes * xpPerMinute * levelMultiplier);

    // Season XP: Flat rate for everyone (fair seasonal competition)
    var seasonTimeXP = Math.floor(activePlayMinutes * xpPerMinute);

    return { totalXP: totalTimeXP, seasonXP: seasonTimeXP };
};

PlayerTracker.prototype.saveSessionToAPI = function () {
    // Save session XP to API server
    if (!this.discordToken) {
        return; // No token = no save
    }

    if (this.sessionSeasonXP <= 0) {
        return; // No XP gained this session
    }

    var sessionDuration = Math.floor((Date.now() - this.sessionStartTime) / 1000);

    var postData = JSON.stringify({
        token: this.discordToken,
        xpGained: this.sessionSeasonXP,
        sessionData: {
            serverName: this.gameServer ? this.gameServer.config.serverName : 'Unknown',
            duration: sessionDuration,
            peakMass: this.sessionPeakMass,
            cellsEaten: this.sessionCellsEaten
        }
    });

    var https = require('https');
    var self = this;

    var options = {
        hostname: 'aetlis.io',
        port: 443,
        path: '/api/xp/update',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'Authorization': 'Vanis ' + this.discordToken
        }
    };

    var req = https.request(options, function (res) {
        var responseData = '';

        res.on('data', function (chunk) {
            responseData += chunk;
        });

        res.on('end', function () {
            if (res.statusCode === 200) {
                Logger.debug('[XP] Session data saved to API for player: ' + self.pID);
            } else {
                Logger.debug('[XP] API error: ' + res.statusCode + ' ' + responseData);
            }
        });
    });

    req.on('error', function (err) {
        Logger.debug('[XP] API request error: ' + err.message);
    });

    req.write(postData);
    req.end();

    // Reset session stats after saving
    this.sessionXP = 0;
    this.sessionSeasonXP = 0;
    this.totalActivePlayTime = 0;
    this.sessionPeakMass = 0;
    this.sessionCellsEaten = 0;
    this.sessionStartTime = Date.now();
};

// =====================================
// AFK DETECTION SYSTEM
// here we goo another shit that i never used it
// =====================================

PlayerTracker.prototype.updatePlayerAction = function (actionType) {
    // Player did an action (split, eject, etc) - update AFK timer
    var oldTime = this.lastActionTime;
    this.lastActionTime = Date.now();
    this.afkWarned = false;

    // Debug log if it's been a while
    var timeSinceLastAction = Date.now() - oldTime;
    if (timeSinceLastAction > 10000) {
        Logger.debug('[AFK-DEBUG] Player ' + this.pID + ' action: ' + actionType + ' after ' + Math.floor(timeSinceLastAction / 1000) + ' seconds');
    }
};

PlayerTracker.prototype.checkAFK = function () {
    // Check if player is AFK (only check when actually playing, not spectating)
    if (this.isMinion || !this.socket || !this.socket.isConnected) return;

    // Don't kick spectators for AFK
    if (!this.isCurrentlyPlaying || this.cells.length === 0) {
        return;
    }

    // TOURNAMENT MODE: Disable AFK timeout
    // We don't want to kick players who are waiting for their turn or camping
    if (this.gameServer.tournamentManager && this.gameServer.tournamentManager.isActive) {
        return;
    }

    var timeSinceLastAction = Date.now() - this.lastActionTime;
    var afkTimeout = (this.gameServer.config.afkTimeout || 40) * 1000;

    // Debug log every 10 seconds
    if (timeSinceLastAction > 10000 && Math.floor(timeSinceLastAction / 1000) % 10 === 0) {
        Logger.debug('[AFK-DEBUG] Player ' + this.pID + ' (' + (this._name || 'Unnamed') + ') no actions for ' + Math.floor(timeSinceLastAction / 1000) + ' seconds (threshold: ' + (afkTimeout / 1000) + 's)');
    }

    if (timeSinceLastAction >= afkTimeout) {
        // Player is AFK (no actions for too long)
        Logger.debug('[AFK] ═══════════════════════════════════════');
        Logger.debug('[AFK] KICKING PLAYER ' + this.pID + ' (' + (this._name || 'Unnamed') + ')');
        Logger.debug('[AFK] Reason: No actions (split/eject) for ' + Math.floor(timeSinceLastAction / 1000) + ' seconds');
        Logger.debug('[AFK] Is playing: ' + this.isCurrentlyPlaying + ' | Cells: ' + this.cells.length);
        Logger.debug('[AFK] ═══════════════════════════════════════');

        if (this.socket && this.socket.isConnected) {
            this.socket.close(1000, "AFK");
        }
    }
};

PlayerTracker.prototype.startAFKCheck = function () {
    // Start AFK checking interval
    if (this.afkCheckInterval) return; // Already running

    var self = this;
    this.afkCheckInterval = setInterval(function () {
        self.checkAFK();
    }, 5000); // Check every 5 seconds
};

PlayerTracker.prototype.stopAFKCheck = function () {
    // Stop AFK checking
    if (this.afkCheckInterval) {
        clearInterval(this.afkCheckInterval);
        this.afkCheckInterval = null;
    }
};

// =====================================
// MOUSE PROJECTION / LINELOCK HELPERS
// Root cell tracking for linesplit
// =====================================

PlayerTracker.prototype._clearProjectionRootMarks = function () {
    for (var i = 0; i < this.cells.length; i++) {
        var cell = this.cells[i];
        if (!cell) continue;
        cell.isRootCell = false;
        cell.rootCellId = 0;
    }
};

PlayerTracker.prototype._hasProjectionRootCell = function () {
    for (var i = 0; i < this.cells.length; i++) {
        var cell = this.cells[i];
        if (!cell || cell.isRemoved) continue;
        if (cell.isRootCell && cell.rootCellId) return true;
    }
    return false;
};

PlayerTracker.prototype._getProjectionRootCell = function () {
    for (var i = 0; i < this.cells.length; i++) {
        var cell = this.cells[i];
        if (!cell || cell.isRemoved) continue;
        if (cell.isRootCell && cell.rootCellId) return cell;
    }
    return null;
};

PlayerTracker.prototype._selectProjectionRootCandidate = function () {
    var largestCell = null;
    var oldestCell = null;
    var largestSize = 0;
    var oldestBirthTick = Number.MAX_VALUE;

    for (var i = 0; i < this.cells.length; i++) {
        var cell = this.cells[i];
        if (!cell || cell.isRemoved) continue;

        if (cell._size > largestSize) {
            largestSize = cell._size;
            largestCell = cell;
        }
        if (cell.birthTick < oldestBirthTick) {
            oldestBirthTick = cell.birthTick;
            oldestCell = cell;
        }
    }

    // Prefer the oldest cell if it's reasonable size, else pick largest
    if (largestCell && oldestCell) {
        if (largestSize > oldestCell._size * 1.5) {
            return largestCell;
        }
        return oldestCell;
    }
    return largestCell || oldestCell;
};

PlayerTracker.prototype.assignProjectionRootCell = function (reason) {
    var candidate = this._selectProjectionRootCandidate();
    if (!candidate) {
        Logger.debug('[PROJECTION] No root candidate for PID=' + this.pID + ' reason=' + (reason || 'unknown'));
        return false;
    }

    this._clearProjectionRootMarks();
    candidate.isRootCell = true;
    candidate.rootCellId = candidate.nodeId;
    Logger.debug('[PROJECTION] 🔁 Assigned root cell for PID=' + this.pID +
        ' reason=' + (reason || 'unknown') +
        ' rootNodeId=' + candidate.nodeId);
    return true;
};

PlayerTracker.prototype.forceReleaseLineLock = function (reason) {
    if (!this.isLineLocked && !this.useMouseProjectionCollision && !this.specialLineSplitLockActive) {
        return;
    }
    Logger.debug('[LINELOCK] Force release for PID=' + this.pID + ' reason=' + (reason || 'unknown'));
    this.isLineLocked = false;
    this.specialLineSplitLockActive = false;
    this.useMouseProjectionCollision = false;
    this.needsProjectionReactivation = true;
    this.projectionActiveUntilTick = 0;
    this.diagonalSnapDisabled = false;
    this._clearProjectionRootMarks();
};

PlayerTracker.prototype._getActiveCellCount = function () {
    var count = 0;
    for (var i = 0; i < this.cells.length; i++) {
        if (this.cells[i] && !this.cells[i].isRemoved) {
            count++;
        }
    }
    return count;
};

PlayerTracker.prototype.onCellRemoved = function (cell) {
    if (!cell || cell.cellType !== 0) return;

    // Check if we need to release linelock because player died
    if (this._getActiveCellCount() === 0) {
        this.forceReleaseLineLock('noCellsRemaining');
        return;
    }

    if (!this.useMouseProjectionCollision) return;

    // If root cell was removed, try to reassign
    if (cell.isRootCell || !this._hasProjectionRootCell()) {
        Logger.debug('[PROJECTION] 🔄 Root cell removed for PID=' + this.pID);
        if (!this.assignProjectionRootCell('cellRemoved')) {
            this.forceReleaseLineLock('rootReassignFailed');
        }
    }
};

// =====================================
// AUTO RESPAWN TIMER 
// =====================================

PlayerTracker.prototype.clearAutoRespawnTimer = function () {
    if (this.autoRespawnTimer) {
        clearTimeout(this.autoRespawnTimer);
        this.autoRespawnTimer = null;
    }
};

// Schedule auto respawn after a short delay
PlayerTracker.prototype._scheduleImmediateAutoRespawn = function (isForced) {
    Logger.debug('[AUTO-RESPAWN]  _scheduleImmediateAutoRespawn() called for Player', this.pID, '(type:', this.playerType, ')', 'forced:', !!isForced);

    var isDualMinion = (this.playerType === 'DUAL_MINION');
    if ((this.isMinion && !isDualMinion) || !this.socket.isConnected) {
        Logger.debug('[AUTO-RESPAWN]  Cannot respawn - isMinion:', this.isMinion, 'connected:', this.socket.isConnected);
        return;
    }

    if (this.autoRespawnTimer) {
        clearTimeout(this.autoRespawnTimer);
        this.autoRespawnTimer = null;
    }

    var respawnDelay = this.gameServer.config.playerRespawnDelay || 1000;
    var respawnContext = isDualMinion ? 'auto_dual' : (isForced ? 'auto_forced' : 'auto');

    var self = this;
    this.autoRespawnTimer = setTimeout(function () {
        self.autoRespawnTimer = null;
        self.executeAutoRespawn(respawnContext);
    }, respawnDelay);
};

// Execute the actual auto respawn
PlayerTracker.prototype.executeAutoRespawn = function (context) {
    Logger.debug('[AUTO-RESPAWN] Timer triggered for Player', this.pID);

    // Check if player is still connected and doesn't have cells
    if (!this.socket.isConnected || this.cells.length > 0 || this.isRemoved) {
        Logger.debug('[AUTO-RESPAWN] Cancelled - connected:', this.socket.isConnected, 'cells:', this.cells.length, 'removed:', this.isRemoved);
        this.clearAutoRespawnTimer();
        return;
    }

    // TOURNAMENT MODE: Check respawn cooldown before allowing auto-respawn
    var tm = this.gameServer.tournamentManager;
    if (tm && tm.isActive) {
        // Get the correct discordId - for dual players, use owner's ID
        var discordId = null;
        var isDual = this.playerType === 'DUAL_MINION';

        if (isDual && this.ownerPlayer) {
            discordId = this.ownerPlayer.discordId;
        } else {
            discordId = this.discordId;
        }

        // DUAL PLAYER: Check if team is full before allowing respawn
        if (isDual && discordId) {
            var spawnError = tm.canPlayerSpawn(this, true); // true = isDual
            if (spawnError) {
                Logger.info('[AUTO-RESPAWN]  Dual respawn blocked - ' + spawnError);
                // this entire section is buggy
                // Silently block - don't spam chat with "Team is full" messages
                // User knows their dual can't respawn, no need to keep reminding

                // Don't respawn, clear timer
                this.clearAutoRespawnTimer();
                return;
            }
        }

        if (discordId) {
            var cooldownCheck = tm.checkRespawnCooldown(discordId);
            if (!cooldownCheck.canRespawn) {
                Logger.info('[AUTO-RESPAWN] Tournament cooldown active, rescheduling in ' + cooldownCheck.remainingTime.toFixed(1) + 's');

                // Send cooldown notification to client
                var socket = isDual && this.ownerPlayer ? this.ownerPlayer.socket : this.socket;
                if (socket && socket.packetHandler) {
                    socket.packetHandler.sendRespawnCooldown(cooldownCheck.remainingTime, isDual);
                }

                // Reschedule auto-respawn after cooldown expires (instant when done)
                var self = this;
                this.clearAutoRespawnTimer();
                this.autoRespawnTimer = setTimeout(function () {
                    self.executeAutoRespawn(context);
                }, cooldownCheck.remainingTime * 1000);
                return;
            }
        }
    }

    Logger.debug('[AUTO-RESPAWN] Player', this.pID, 'auto-respawning as "' + this.lastSpawnName + '" (context:', context || 'auto', 'type:', this.playerType, ')');

    // Clear the timer reference
    this.autoRespawnTimer = null;

    // Respawn the player with their last used name and skin
    var spawnContext = context || (this.playerType === 'DUAL_MINION' ? 'auto_dual' : 'auto');
    this.joinGame(this.lastSpawnName, this.lastSpawnSkin, { context: spawnContext });
};

// =====================================
// DUAL PLAYER SYSTEM - Multibox

// =====================================

// Helper: Get identity info for dual player (custom name/skin or fallback to owner's)
PlayerTracker.prototype._getDualIdentity = function () {
    var name = '';
    var skin = '';
    if (this.playerType === 'REGULAR') {
        if (typeof this.dualNickname === 'string' && this.dualNickname.trim().length > 0) {
            name = this.dualNickname.trim();
        } else {
            name = this._name || '';
        }
        if (typeof this.dualSkinUrl === 'string' && this.dualSkinUrl.trim().length > 0) {
            skin = this.dualSkinUrl.trim();
        } else {
            skin = this._skin || '';
        }
    } else {
        name = this._name || '';
        skin = this._skin || '';
    }
    if (name.length > 15) {
        name = name.substring(0, 15);
    }
    return {
        name: name,
        skin: skin
    };
};

// Helper: Normalize name for perk matching (strips tags, lowercase)
PlayerTracker.prototype._normalizeNameForPerks = function (name) {
    if (!name) return '';
    var value = ('' + name).trim();
    if (value[0] === '<') {
        var closeIdx = value.indexOf('>');
        if (closeIdx >= 0) {
            value = value.slice(closeIdx + 1).trim();
        }
    }
    return value.toLowerCase();
};

// Helper: Apply name color to dual player if names match
PlayerTracker.prototype._applyDualNameColorLock = function (dualPlayer, providedName) {
    if (!dualPlayer) return;
    var reference = this.lockedNameNormalized || this._normalizeNameForPerks(this._name || '');
    var compareName = providedName || dualPlayer._name || '';
    var normalizedDual = this._normalizeNameForPerks(compareName);
    var canUseColor = !!reference &&
        normalizedDual === reference &&
        !!this.nameColor &&
        !!this.nameColorEnabled;

    if (canUseColor) {
        dualPlayer.nameColor = this.nameColor;
        dualPlayer.nameColorEnabled = true;
    } else {
        dualPlayer.nameColor = null;
        dualPlayer.nameColorEnabled = false;
    }
};

// Helper: Sync badge from owner to dual player
PlayerTracker.prototype._syncDualBadge = function () {
    if (!this.dualPlayer) return;
    this.dualPlayer.badgeId = this.badgeId || 0;
};

// Create a dual player - multibox time baby!
PlayerTracker.prototype.createDualPlayer = function () {
    Logger.info('[DUAL] ========== CREATE DUAL ==========');
    Logger.info('[DUAL] Owner PID=' + this.pID + ' Name=' + (this._name || ''));
    Logger.info('[DUAL] Owner cells=' + this.cells.length);

    if (this.playerType !== 'REGULAR') {
        Logger.warn('[DUAL] DUAL_MINION cannot create a dual player');
        return;
    }

    if (this.dualPlayer) {
        Logger.warn('[DUAL] Dual player already exists for player ' + this.pID);
        return;
    }

    Logger.info('[DUAL] Creating dual player for ' + this.pID);

    // Create a fake socket for the dual player
    var ownerPacketHandler = this.socket && this.socket.packetHandler;
    var dualPacketHandler = {
        isVanis: ownerPacketHandler ? ownerPacketHandler.isVanis : false,
        protocol: ownerPacketHandler ? ownerPacketHandler.protocol : 0,
        process: function () { },
        sendVanisPlayerInfo: function () { },
        sendVanisLeaderboard: function () { },
        sendVanisChat: function () { },
        sendDualPlayerUpdate: function () { },
        broadcastPlayerInfo: function () { },
        // Delegate linelock methods to owner's handler
        _maybeSnapMouseForLineLock: ownerPacketHandler && typeof ownerPacketHandler._maybeSnapMouseForLineLock === 'function'
            ? ownerPacketHandler._maybeSnapMouseForLineLock.bind(ownerPacketHandler)
            : function () { },
        executeLinelock: ownerPacketHandler && typeof ownerPacketHandler.executeLinelock === 'function'
            ? ownerPacketHandler.executeLinelock.bind(ownerPacketHandler)
            : function () { },
        executeSpecialLinelock: ownerPacketHandler && typeof ownerPacketHandler.executeSpecialLinelock === 'function'
            ? ownerPacketHandler.executeSpecialLinelock.bind(ownerPacketHandler)
            : function () { },
        executeDiagonalLinesplitNotice: ownerPacketHandler && typeof ownerPacketHandler.executeDiagonalLinesplitNotice === 'function'
            ? ownerPacketHandler.executeDiagonalLinesplitNotice.bind(ownerPacketHandler)
            : function () { }
    };

    var dualSocket = {
        isConnected: true,
        isBot: false,
        remoteAddress: 'dual-local',
        playerTracker: null,
        packetHandler: dualPacketHandler,
        sendPacket: function () { },
        send: function () { },
        close: function () { this.isConnected = false; },
        _socket: { writable: true }
    };
    dualPacketHandler.socket = dualSocket;

    // Create the dual player tracker
    this.dualPlayer = new PlayerTracker(this.gameServer, dualSocket);
    dualSocket.playerTracker = this.dualPlayer;

    // Configure dual player
    this.dualPlayer.playerType = 'DUAL_MINION';
    this.dualPlayer.ownerPlayer = this;
    this.dualPlayer.isMinion = true; // Mark as minion for game logic

    // Inherit frozen state from owner - tournament mode needs this
    this.dualPlayer.frozen = this.frozen;

    // Copy settings from owner (use custom dual identity if provided)
    var dualIdentity = this._getDualIdentity();
    this.dualPlayer.setName(dualIdentity.name);
    this.dualPlayer.setSkin(dualIdentity.skin);
    this.dualPlayer.setColor(this.color);
    this.dualPlayer.badgeId = this.badgeId;
    this.dualPlayer._tag = this._tag;
    this.dualPlayer.clientWantsRememberMousePosition = this.clientWantsRememberMousePosition;
    this.dualPlayer.clientWantsLockInactivePosition = this.clientWantsLockInactivePosition;
    this._applyDualNameColorLock(this.dualPlayer, dualIdentity.name);

    // Sync initial mouse position from owner
    this.dualPlayer.mouse.x = this.mouse.x;
    this.dualPlayer.mouse.y = this.mouse.y;
    this.dualPlayer.lockedMouseX = this.mouse.x;
    this.dualPlayer.lockedMouseY = this.mouse.y;

    // Spawn the dual player immediately
    Logger.info('[DUAL] Calling joinGame for dual player PID=' + this.dualPlayer.pID);
    Logger.info('[DUAL] Dual player name=' + (this.dualPlayer._name || '') + ' Skin=' + (this.dualPlayer._skin || ''));

    this.dualPlayer.joinGame(this.dualPlayer._name, this.dualPlayer._skin, { context: 'dual_create' });

    Logger.info('[DUAL] After joinGame - dual player cells=' + this.dualPlayer.cells.length);

    // Add dual player socket to gameServer.clients so it gets updated
    if (this.gameServer && this.gameServer.clients.indexOf(dualSocket) === -1) {
        this.gameServer.clients.push(dualSocket);
        Logger.info('[DUAL] Dual player socket added to clients list');

        // Update player count API - dual player counts as a new player!
        if (typeof this.gameServer.updateGameserversJsonOnPlayerChange === 'function') {
            this.gameServer.updateGameserversJsonOnPlayerChange();
            Logger.info('[DUAL] Updated API player count after dual creation');
        }
    } else {
        Logger.warn('[DUAL] Could not add dual player socket to clients list');
    }

    Logger.info('[DUAL] Dual player ' + this.dualPlayer.pID + ' created for owner ' + this.pID);
    Logger.info('[DUAL] Final dual player cells=' + this.dualPlayer.cells.length);

    // Send dual player update to owner
    if (this.socket && this.socket.packetHandler) {
        if (typeof this.socket.packetHandler.sendDualPlayerUpdate === 'function') {
            Logger.info('[DUAL] Sending dual player update packet to owner');
            this.socket.packetHandler.sendDualPlayerUpdate(this);
        }

        // Broadcast player info to all clients
        if (typeof this.socket.packetHandler.broadcastPlayerInfo === 'function') {
            Logger.info('[DUAL] Broadcasting dual player info to all clients');
            this.socket.packetHandler.broadcastPlayerInfo(this.dualPlayer);
        }
    }

    Logger.info('[DUAL] ========== CREATE DUAL PLAYER END ==========');
};

// Destroy dual player - back to solo mode
PlayerTracker.prototype.destroyDualPlayer = function () {
    if (this.playerType !== 'REGULAR') {
        Logger.debug('[DUAL] DUAL_MINION cannot destroy a dual player');
        return;
    }

    if (!this.dualPlayer) {
        Logger.debug('[DUAL] No dual player to destroy');
        return;
    }

    Logger.debug('[DUAL] Destroying dual player', this.dualPlayer.pID, 'for owner', this.pID);

    // Remove from clients list
    if (this.gameServer && this.dualPlayer.socket) {
        var index = this.gameServer.clients.indexOf(this.dualPlayer.socket);
        if (index != -1) {
            this.gameServer.clients.splice(index, 1);

            // Update player count API - dual player is gone!
            if (typeof this.gameServer.updateGameserversJsonOnPlayerChange === 'function') {
                this.gameServer.updateGameserversJsonOnPlayerChange();
                Logger.info('[DUAL] Updated API player count after dual destruction');
            }
        }
    }

    // Remove all cells
    while (this.dualPlayer.cells.length > 0) {
        var cell = this.dualPlayer.cells[0];
        this.gameServer.removeNode(cell);
    }

    // Clear any pending auto-respawn timers
    if (this.dualPlayer.autoRespawnTimer) {
        clearTimeout(this.dualPlayer.autoRespawnTimer);
        this.dualPlayer.autoRespawnTimer = null;
    }

    // Mark for removal
    this.dualPlayer.isRemoved = true;
    this.dualPlayer = null;
    this.isDualActive = false;

    // Send update to owner
    if (this.socket && this.socket.packetHandler && typeof this.socket.packetHandler.sendDualPlayerUpdate === 'function') {
        this.socket.packetHandler.sendDualPlayerUpdate(this);
    }
};

// Get the currently active controlled player (main or dual)
PlayerTracker.prototype.getActiveControlledPlayer = function () {
    if (this.playerType === 'DUAL_MINION') {
        if (this.ownerPlayer) {
            return this.ownerPlayer.getActiveControlledPlayer();
        }
        return this;
    }

    if (this.dualPlayer && this.isDualActive) {
        return this.dualPlayer;
    }
    return this;
};

// Set which player is active (main or dual)
PlayerTracker.prototype.setDualActive = function (active) {
    if (this.playerType === 'DUAL_MINION') {
        Logger.debug('[DUAL] DUAL_MINION cannot set dual active state');
        return;
    }

    // If no dual player exists, just set the flag and return
    // Tab switch should NEVER be blocked - always allow switching
    if (!this.dualPlayer) {
        Logger.debug('[DUAL] No dual player exists, setting isDualActive=' + active);
        this.isDualActive = active;
        return;
    }

    var previouslyActivePlayer = this.getActiveControlledPlayer();
    var oldEjectState = previouslyActivePlayer ? previouslyActivePlayer.ejectMacro : false;

    // Handle position locking
    var wantsRememberMouse = this.clientWantsRememberMousePosition || this.minionControlActive;
    if (!wantsRememberMouse) {
        var becomingInactivePlayer = active ? this : this.dualPlayer;
        if (becomingInactivePlayer) {
            becomingInactivePlayer.isLockedToPosition = true;
            becomingInactivePlayer.lockedMouseX = becomingInactivePlayer.mouse.x;
            becomingInactivePlayer.lockedMouseY = becomingInactivePlayer.mouse.y;
            becomingInactivePlayer.mouse.x = becomingInactivePlayer.lockedMouseX;
            becomingInactivePlayer.mouse.y = becomingInactivePlayer.lockedMouseY;
        }

        var becomingActivePlayer = active ? this.dualPlayer : this;
        if (becomingActivePlayer) {
            becomingActivePlayer.isLockedToPosition = false;
        }
    } else {
        this.isLockedToPosition = false;
        if (this.dualPlayer) {
            this.dualPlayer.isLockedToPosition = false;
        }
    }

    this.isDualActive = active;
    Logger.debug('[DUAL] Dual active state set to:', active, 'for player', this.pID);

    // Reset death tracking based on which player we're switching TO
    // This means user is actively paying attention to that player now
    if (active && this.dualPlayer) {
        // Switching TO dual - reset dual's death counter (user is now watching dual)
        if (this.dualPlayer.dualDeathsWhileInactive > 0 || this.dualPlayer.dualRespawnBlocked) {
            Logger.info('[DUAL]  Tab switched TO dual - resetting dual death counter');
            this.dualPlayer.dualDeathsWhileInactive = 0;
            this.dualPlayer.dualRespawnBlocked = false;
            this.dualPlayer._deathAlreadyCounted = false;
            // Reset respawn rate limit so user can immediately respawn
            if (this.socket && this.socket.packetHandler) {
                this.socket.packetHandler.lastJoinTick = 0;
            }
        }
    } else if (!active) {
        // Switching TO main - reset main's death counter (user is now watching main)
        if (this.mainDeathsWhileInactive > 0 || this.mainRespawnBlocked) {
            Logger.info('[MAIN] 🔄 Tab switched TO main - resetting main death counter');
            this.mainDeathsWhileInactive = 0;
            this.mainRespawnBlocked = false;
            this._mainDeathAlreadyCounted = false;
            // Reset respawn rate limit so user can immediately respawn
            if (this.socket && this.socket.packetHandler) {
                this.socket.packetHandler.lastJoinTick = 0;
            }
        }
    }


    // Handle eject macro state based on client preference
    var newlyDeactivatedPlayer = this.isDualActive ? this : this.dualPlayer;
    var packetHandler = this.socket ? this.socket.packetHandler : null;
    var activeControlled = this.getActiveControlledPlayer();

    if (!this.clientWantsRememberEjecting) {
        if (newlyDeactivatedPlayer && newlyDeactivatedPlayer !== activeControlled) {
            newlyDeactivatedPlayer.ejectMacro = false;
        }
    }

    if (packetHandler && packetHandler.feedKeyHeld) {
        if (activeControlled) {
            activeControlled.ejectMacro = true;
        }
        if (!this.clientWantsRememberEjecting && newlyDeactivatedPlayer && newlyDeactivatedPlayer !== activeControlled) {
            newlyDeactivatedPlayer.ejectMacro = false;
        }
    }

    // Send update to client
    if (this.socket && this.socket.packetHandler && typeof this.socket.packetHandler.sendDualPlayerUpdate === 'function') {
        this.socket.packetHandler.sendDualPlayerUpdate(this);
    }
};

// Set minion control preference (control dual with separate inputs)
PlayerTracker.prototype.setMinionControlPreference = function (enabled) {
    enabled = !!enabled;
    if (this.minionControlActive === enabled) {
        return;
    }

    this.minionControlActive = enabled;
    Logger.info('[DUAL] Minion control ' + (enabled ? 'ENABLED' : 'DISABLED') + ' for owner PID=' + this.pID);

    if (enabled && this.isDualActive) {
        // Force control back to the main player to avoid camera switches
        this.setDualActive(false);
    }

    if (enabled) {
        this.clientWantsRememberMousePosition = true;
        this.clientWantsLockInactivePosition = false;
    }

    if (this.dualPlayer) {
        // Reset line-lock related state whenever preference changes
        this.dualPlayer.isLineLocked = false;
        this.dualPlayer.specialLineSplitLockActive = false;
        this.dualPlayer.useMouseProjectionCollision = false;
        this.dualPlayer.needsProjectionReactivation = true;
        this.dualPlayer.projectionActiveUntilTick = 0;

        if (!enabled) {
            this.dualPlayer.ejectMacro = false;
        }
    }

    if (enabled && this.dualPlayer) {
        this.dualPlayer.clientWantsRememberMousePosition = true;
        this.dualPlayer.clientWantsLockInactivePosition = false;

        // Reset dual death tracking - minion control means we're controlling the dual
        // so any previous "inactive deaths" are forgiven
        if (this.dualPlayer.dualDeathsWhileInactive > 0 || this.dualPlayer.dualRespawnBlocked) {
            Logger.info('[DUAL]  Minion control enabled - resetting dual death counter');
            this.dualPlayer.dualDeathsWhileInactive = 0;
            this.dualPlayer.dualRespawnBlocked = false;
            this.dualPlayer._deathAlreadyCounted = false;
        }
    }
};

// Check if player is in dual mode
PlayerTracker.prototype.isDualMode = function () {
    if (this.playerType === 'REGULAR') {
        return this.dualPlayer !== null;
    }
    if (this.playerType === 'DUAL_MINION' && this.ownerPlayer) {
        return this.ownerPlayer.isDualMode();
    }
    return false;
};
