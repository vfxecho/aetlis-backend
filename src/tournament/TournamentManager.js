/**
 * Tournament Manager - The brain behind competitive chaos
 * Handles all tournament logic: rounds, scoring, freeze, timers, the whole shebang
 */

var Logger = require('../modules/Logger');

// Referee role IDs that can control tournaments (multiple roles supported)
var REFEREE_ROLE_IDS = [
    '1442902542903152701',  // Original referee role
    '1446028475470446654'   // Additional referee role
];

function TournamentManager(gameServer) {
    this.gameServer = gameServer;

    // ========================================
    // TOURNAMENT STATE - The holy grail of match data
    // ========================================
    this.isActive = false;              // Is a tournament currently running?
    this.isFrozen = true;               // Are players frozen? (can't move)
    this.isPaused = false;              // Is the game paused by referee?
    this.roundStarted = false;          // Has the current round actually started?

    // Timer shit
    this.matchDuration = 8 * 60;        // 8 minutes in seconds (configurable)
    this.timeRemaining = this.matchDuration;
    this.lastTimerTick = 0;             // Last timestamp for timer update
    this.countdownActive = false;       // Is 3-2-1 countdown happening?
    this.countdownValue = 0;            // Current countdown number
    this.lastMinuteAnnounced = -1;      // Track which minute we last announced
    this.unpauseCountdownActive = false; // Is unpause countdown happening?

    // Round & Score tracking
    this.currentRound = 0;              // Current round number (1, 2, 3...)
    this.maxRounds = 5;                 // Max rounds before sudden death
    this.pointsToWin = 3;               // First to 3 wins

    // Team data - the competing gladiators
    this.teams = {
        team1: {
            name: 'Team 1',
            players: [],                // Array of discordIds
            score: 0,                   // Rounds won
            totalMass: 0,               // Current total mass
            spawnSide: 'left',          // Which side they spawn on
            color: '#FF6B6B'            // Team color for UI
        },
        team2: {
            name: 'Team 2',
            players: [],
            score: 0,
            totalMass: 0,
            spawnSide: 'right',
            color: '#4ECDC4'
        }
    };

    // Chat filter - hide spectator messages from players
    this.filterSpectatorChat = false;

    // Respawn cooldown tracking (discordId -> timestamp when they can respawn)
    this.respawnCooldowns = {};
    // Get respawn cooldown from config (default: 8 seconds if not set)
    var configCooldown = this.gameServer.config.tournamentRespawnCooldown;
    this.respawnCooldownDuration = (configCooldown && configCooldown > 0) ? configCooldown : 8;
    this.nearDeathRespawnEnabled = true; // Toggle for near-death respawn

    // Round history for rematch functionality
    this.roundHistory = [];             // [{round: 1, winner: 'team1', team1Mass: 5000, team2Mass: 3000}]

    // Tick counters for periodic updates
    this.lastMassUpdateTick = 0;
    this.lastStateUpdateTick = 0;

    // Border shrinking state - the arena gets smaller and shit gets real
    this.borderShrinkActive = false;      // Is border currently shrinking?
    this.currentBorderSize = 0;           // Current border width/height (or radius for circular)
    this.originalBorderSize = 0;          // Original border size before shrinking
    this.lastBorderUpdateTick = 0;        // Last tick when border was updated

    // Team size limits - parsed from tournament format (e.g., 3v3 = 3 per team)
    this.teamSizeLimit = 0;               // 0 = no limit, otherwise max players per team (including duals!)
    this.tournamentFormat = '';           // e.g., "3v3", "2v2", "1v1"

    // Reset requirement - after round ends, referee MUST press Reset before Start
    this.needsReset = false;              // true = round ended, waiting for reset

    Logger.info('[TOURNAMENT-MANAGER] 🏆 Initialized and ready for some competitive bloodshed');
}

// ========================================
// INITIALIZATION & SETUP
// ========================================

/**
 * Initialize tournament with teams from Discord bot
 * @param {Object} config - {team1Name, team1Players, team2Name, team2Players, duration}
 */
TournamentManager.prototype.initTournament = function (config) {
    if (!config) {
        Logger.warn('[TOURNAMENT-MANAGER] No config provided, using defaults');
        return false;
    }

    // Reset everything - clean slate
    this.reset();

    // Set team names
    this.teams.team1.name = config.team1Name || 'Team 1';
    this.teams.team2.name = config.team2Name || 'Team 2';

    // Set team players (discord IDs)
    this.teams.team1.players = config.team1Players || [];
    this.teams.team2.players = config.team2Players || [];

    // Set match duration if provided
    if (config.duration && config.duration > 0) {
        this.matchDuration = config.duration * 60; // Convert minutes to seconds
        this.timeRemaining = this.matchDuration;
    }

    // Set respawn cooldown from config (default: 8 seconds)
    if (this.gameServer && this.gameServer.config && this.gameServer.config.tournamentRespawnCooldown) {
        this.respawnCooldownDuration = Math.max(0, Math.min(30, this.gameServer.config.tournamentRespawnCooldown));
        Logger.info('[TOURNAMENT-MANAGER] Respawn cooldown from config: ' + this.respawnCooldownDuration + 's');
    }

    // Parse tournament format (e.g., "3v3", "2v2", "1v1") to set team size limit
    // Format can be in serverName or passed directly
    this.parseTournamentFormat(config.format || this.gameServer.config.serverName || '');

    // Mark tournament as active but frozen
    this.isActive = true;
    this.isFrozen = true;
    this.currentRound = 1;

    // Freeze all existing players and bots immediately
    this.freezeAllPlayers();

    Logger.info('[TOURNAMENT-MANAGER] 🎮 Tournament initialized:');
    Logger.info('[TOURNAMENT-MANAGER] ' + this.teams.team1.name + ' vs ' + this.teams.team2.name);
    Logger.info('[TOURNAMENT-MANAGER] Format: ' + (this.tournamentFormat || 'unlimited') + ' (max ' + (this.teamSizeLimit || '∞') + ' per team)');
    Logger.info('[TOURNAMENT-MANAGER] Duration: ' + (this.matchDuration / 60) + ' minutes');
    Logger.info('[TOURNAMENT-MANAGER] Respawn cooldown: ' + this.respawnCooldownDuration + 's');
    Logger.info('[TOURNAMENT-MANAGER] Team 1 players: ' + this.teams.team1.players.join(', '));
    Logger.info('[TOURNAMENT-MANAGER] Team 2 players: ' + this.teams.team2.players.join(', '));

    // Broadcast initial state to all clients
    this.broadcastTournamentState();

    return true;
};

/**
 * Parse tournament format from string (e.g., "OAT#1 — 2v2 Megasplit", "3v3 Multibox", "1v1")
 * Sets teamSizeLimit based on format
 * Also ENABLES dual mode (dualDisabled = 0) for ALL tournaments!
 */
TournamentManager.prototype.parseTournamentFormat = function (formatString) {
    if (!formatString) {
        this.teamSizeLimit = 0;
        this.tournamentFormat = '';
        return;
    }

    // Look for patterns like "3v3", "2v2", "1v1", "4v4" etc.
    // Works with: "OAT#1 — 2v2 Megasplit", "3v3 Multibox", "1v1", "2 v 2" etc.
    Logger.debug('[TOURNAMENT-MANAGER] Parsing format from: "' + formatString + '"');

    var match = formatString.match(/(\d+)\s*[vVxX]\s*(\d+)/);
    if (match) {
        var team1Size = parseInt(match[1], 10);
        var team2Size = parseInt(match[2], 10);

        // ALWAYS allow unlimited players even if format says 3v3
        // This is per user request "make the both teams max capacity even tho its 3v3"
        this.teamSizeLimit = 0;
        this.tournamentFormat = team1Size + 'v' + team2Size;

        Logger.info('[TOURNAMENT-MANAGER] ✅ Parsed format: "' + formatString + '" -> ' + this.tournamentFormat + ' (max UNLIMITED per team)');
    } else {
        this.teamSizeLimit = 0; // No limit
        this.tournamentFormat = '';
        Logger.info('[TOURNAMENT-MANAGER] ⚠️ No format found in: "' + formatString + '" -> unlimited teams');
    }

    // ALWAYS enable dual mode for tournaments (regardless of Multibox in name)
    // Dual is essential for competitive play - don't fuck with it
    if (this.gameServer && this.gameServer.config) {
        this.gameServer.config.dualDisabled = 0;
        Logger.info('[TOURNAMENT-MANAGER] Dual mode ENABLED for tournament (dualDisabled = 0)');
    }
};

/**
 * Reset tournament to initial state
 */
TournamentManager.prototype.reset = function () {
    this.isActive = false;
    this.isFrozen = true;
    this.isPaused = false;
    this.roundStarted = false;
    this.countdownActive = false;
    this.countdownValue = 0;
    this.unpauseCountdownActive = false;
    this.currentRound = 0;
    this.timeRemaining = this.matchDuration;
    this.lastMinuteAnnounced = -1;
    this.filterSpectatorChat = false;
    this.respawnCooldowns = {}; // Clear respawn cooldowns
    this.teamSizeLimit = 0;     // Reset team size limit
    this.tournamentFormat = ''; // Reset format

    // Reset border to original size - ONLY on full tournament reset
    this.resetBorderShrink();

    // Clear all bots on reset, then re-add them
    this._resetBots();

    this.teams.team1.score = 0;
    this.teams.team1.totalMass = 0;
    this.teams.team1.players = [];

    this.teams.team2.score = 0;
    this.teams.team2.totalMass = 0;
    this.teams.team2.players = [];

    this.roundHistory = [];

    Logger.info('[TOURNAMENT-MANAGER] Tournament state reset');
};

/**
 * Reset bots - remove all and re-add configured amount
 * Called during tournament reset to ensure fresh bot state
 */
TournamentManager.prototype._resetBots = function () {
    var gs = this.gameServer;
    if (!gs || !gs.bots) return;

    // Count current bots
    var botClients = [];
    for (var i = 0; i < gs.clients.length; i++) {
        var client = gs.clients[i];
        if (!client || !client.playerTracker) continue;
        if (client.playerTracker.isBot === true) {
            botClients.push(client);
        }
    }

    var currentBots = botClients.length;
    var configuredBots = gs.config.serverBots || 0;

    Logger.info('[TOURNAMENT-MANAGER] Resetting bots: ' + currentBots + ' current, ' + configuredBots + ' configured');

    // Remove all existing bots
    for (var i = botClients.length - 1; i >= 0; i--) {
        var client = botClients[i];
        if (!client) continue;

        // Remove player cells
        if (client.playerTracker && client.playerTracker.cells) {
            while (client.playerTracker.cells.length > 0) {
                gs.removeNode(client.playerTracker.cells[0]);
            }
        }

        // Remove from clients array
        var idx = gs.clients.indexOf(client);
        if (idx !== -1) {
            gs.clients.splice(idx, 1);
        }

        // Close socket
        try {
            if (client.close && typeof client.close === 'function') {
                client.close();
            }
        } catch (e) { }
    }

    // Re-add configured amount of bots
    if (configuredBots > 0) {
        for (var i = 0; i < configuredBots; i++) {
            gs.bots.addBot();
        }
        Logger.info('[TOURNAMENT-MANAGER] Re-added ' + configuredBots + ' bots');
    }
};

// ========================================
// PLAYER & TEAM MANAGEMENT
// ========================================

/**
 * Get which team a player belongs to
 * @param {string} discordId - Player's Discord ID
 * @returns {string|null} - 'team1', 'team2', or null if spectator
 */
TournamentManager.prototype.getPlayerTeam = function (discordId) {
    if (!discordId) return null;

    var id = String(discordId);

    if (this.teams.team1.players.indexOf(id) !== -1) {
        return 'team1';
    }
    if (this.teams.team2.players.indexOf(id) !== -1) {
        return 'team2';
    }

    return null; // Spectator
};

/**
 * Count active players in a team (including dual players!)
 * Only counts players who are ACTUALLY IN GAME (have cells)
 * @param {string} teamKey - 'team1' or 'team2'
 * @returns {number} - Total player count (main + dual = 2 if both have cells)
 */
TournamentManager.prototype.getTeamActivePlayerCount = function (teamKey) {
    var teamData = this.teams[teamKey];
    if (!teamData) return 0;

    var count = 0;
    var clients = this.gameServer.clients;
    Logger.debug('[TOURNAMENT-DEBUG] Counting active players for ' + teamKey + ' (Limit: ' + this.teamSizeLimit + ')');

    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var player = client.playerTracker;

        // Skip if it's a dual minion (we'll count it with the owner)
        if (player.playerType === 'DUAL_MINION') continue;

        // Check if player belongs to this team
        if (player.discordId && teamData.players.indexOf(String(player.discordId)) !== -1) {
            // Only count main player if they have cells (actually spawned!)
            if (player.cells && player.cells.length > 0) {
                Logger.debug('[TOURNAMENT-DEBUG]   + Found active player: ' + (player._name || 'Unnamed') + ' (PID: ' + player.pID + ')');
                count++;
            }
        }
    }

    Logger.debug('[TOURNAMENT-DEBUG] Total count for ' + teamKey + ': ' + count);
    return count;
};

/**
 * Check if a team is full (based on tournament format like 3v3)
 * IMPORTANT: Dual players count as a separate slot!
 * @param {string} teamKey - 'team1' or 'team2'
 * @returns {boolean} - true if team is full
 */
TournamentManager.prototype.isTeamFull = function (teamKey) {
    // No limit set? Never full
    if (!this.teamSizeLimit || this.teamSizeLimit <= 0) return false;

    var activeCount = this.getTeamActivePlayerCount(teamKey);
    return activeCount >= this.teamSizeLimit;
};

/**
 * Check if player can spawn (team not full)
 * Returns error message if cannot spawn, null if OK
 * @param {PlayerTracker} player - The player trying to spawn
 * @param {boolean} isDual - Whether this is a dual spawn attempt
 * @returns {string|null} - Error message or null if OK to spawn
 */
TournamentManager.prototype.canPlayerSpawn = function (player, isDual) {
    if (!this.isActive) return null; // No tournament, anyone can spawn

    // For dual players, check owner's discordId
    var discordId = isDual && player.ownerPlayer ? player.ownerPlayer.discordId : player.discordId;
    if (!discordId) return 'Not registered for tournament';

    var team = this.getPlayerTeam(discordId);
    if (!team) return 'Not on any team - spectator only';

    // Check team size limit
    if (this.teamSizeLimit > 0) {
        var currentCount = this.getTeamActivePlayerCount(team);

        // After this spawn, how many will there be?
        // Current count doesn't include this player yet (they have 0 cells)
        // FIX: Only main players count towards the limit! Duals are free slots attached to main players.
        var afterSpawnCount = currentCount + (isDual ? 0 : 1);

        Logger.debug('[TOURNAMENT-SPAWN] Team ' + team + ' check: ' + currentCount + '/' + this.teamSizeLimit +
            ' (after spawn: ' + afterSpawnCount + ') isDual=' + isDual);

        // Check if there's room
        if (afterSpawnCount > this.teamSizeLimit) {
            Logger.warn('[TOURNAMENT-SPAWN] ❌ Blocked: Team ' + team + ' is full (' + currentCount + '/' + this.teamSizeLimit + ')');
            return 'Team is full (' + currentCount + '/' + this.teamSizeLimit + ')';
        }
    }

    Logger.debug('[TOURNAMENT-SPAWN] ✅ Spawn allowed for ' + (isDual ? 'dual' : 'main') + ' player');
    return null; // OK to spawn
};

/**
 * Check if player is a referee
 * @param {PlayerTracker} player - The player to check
 * @returns {boolean}
 */
TournamentManager.prototype.isReferee = function (player) {
    if (!player) return false;

    // Check player's referee flag (set during Discord verification)
    return player.isReferee === true || player.adminLevel >= 1;
};

/**
 * Check if enemy team info (skin, minimap) should be hidden from viewer
 * HIDE during: active round, paused state
 * SHOW during: frozen state (reset, prep time, after round won)
 * 
 * @param {PlayerTracker} viewer - The player viewing
 * @param {PlayerTracker} target - The player being viewed
 * @returns {boolean} - true if target's skin/minimap should be hidden from viewer
 */
TournamentManager.prototype.shouldHideEnemyInfo = function (viewer, target) {
    // Not active tournament = show everything
    if (!this.isActive) return false;

    // If frozen (reset state, prep time, after round won) = show everything
    if (this.isFrozen) return false;

    // If round not started = show everything
    if (!this.roundStarted) return false;

    // Active round or paused = hide enemy team info
    // (isPaused is included - we still hide during pause)

    // Get viewer's team
    var viewerDiscordId = null;
    if (viewer) {
        if (viewer.playerType === 'DUAL_MINION' && viewer.ownerPlayer) {
            viewerDiscordId = viewer.ownerPlayer.discordId;
        } else {
            viewerDiscordId = viewer.discordId;
        }
    }
    var viewerTeam = viewerDiscordId ? this.getPlayerTeam(viewerDiscordId) : null;

    // Get target's team
    var targetDiscordId = null;
    if (target) {
        if (target.playerType === 'DUAL_MINION' && target.ownerPlayer) {
            targetDiscordId = target.ownerPlayer.discordId;
        } else {
            targetDiscordId = target.discordId;
        }
    }
    var targetTeam = targetDiscordId ? this.getPlayerTeam(targetDiscordId) : null;

    // If viewer is not on a team (spectator/referee), show everything
    if (!viewerTeam) return false;

    // If target is not on a team (spectator/bot), show everything
    if (!targetTeam) return false;

    // If same team, show
    if (viewerTeam === targetTeam) return false;

    // Different teams during active round = HIDE
    return true;
};

/**
 * Re-broadcast all player info to all clients
 * This is called when tournament round starts/ends so skin visibility updates immediately
 * Without this, clients would keep showing cached skins until players respawn
 */
TournamentManager.prototype.rebroadcastAllPlayerInfo = function () {
    var clients = this.gameServer.clients;
    var playerList = [];

    // Collect all players to broadcast
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;
        if (client.playerTracker.cells.length === 0) continue; // No cells = nothing to show
        playerList.push(client.playerTracker);

        // Also add dual player if exists
        if (client.playerTracker.dualPlayer && client.playerTracker.dualPlayer.cells.length > 0) {
            playerList.push(client.playerTracker.dualPlayer);
        }
    }

    // Re-send player info to all Vanis clients
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.packetHandler || !client.packetHandler.isVanis) continue;
        if (!client.isConnected) continue;

        // Send all players' info to this client
        for (var j = 0; j < playerList.length; j++) {
            if (typeof client.packetHandler.sendVanisPlayerInfo === 'function') {
                client.packetHandler.sendVanisPlayerInfo(playerList[j]);
            }
        }
    }

    Logger.info('[TOURNAMENT-MANAGER] Re-broadcast player info to all clients (' + playerList.length + ' players)');
};

/**
 * Check if a player should be blocked from auto-respawning
 * Used by PlayerTracker to prevent auto-respawn during tournament
 * @param {PlayerTracker} player - The player to check
 * @returns {boolean} - true if respawn should be blocked
 */
TournamentManager.prototype.isRespawnBlocked = function (player) {
    // If tournament not active, don't block anything
    if (!this.isActive) return false;

    // If frozen or paused, block respawn - wait for referee to unfreeze
    if (this.isFrozen || this.isPaused) return true;

    // Get the discord ID - for dual players, use owner's ID
    var discordId = null;
    if (player) {
        if (player.playerType === 'DUAL_MINION' && player.ownerPlayer) {
            discordId = player.ownerPlayer.discordId;
        } else {
            discordId = player.discordId;
        }
    }

    // If player has no discord ID, block respawn (spectator or unregistered)
    if (!discordId) return true;

    // Check if player is registered for tournament
    var team = this.getPlayerTeam(discordId);
    if (!team) {
        // Spectator - block auto-respawn
        return true;
    }

    // Check respawn cooldown - block if still on cooldown
    var cooldownCheck = this.checkRespawnCooldown(discordId);
    if (!cooldownCheck.canRespawn) {
        return true;
    }

    // Registered players can respawn during active round (after cooldown)
    return false;
};

/**
 * Get spawn position for a player based on their team
 * Uses FIXED index based on registered team list (not dynamic alive players)
 * 
 * Spawn Layout:
 * - Team 1 on LEFT side, Team 2 on RIGHT side
 * - Players spread vertically with spacing
 * - Each player gets unique position (no overlap!)
 * 
 * @param {string} discordId - Player's Discord ID
 * @param {PlayerTracker} player - Optional player tracker for dual detection
 * @returns {Object} - {x, y} spawn position or null for random/near-death spawn
 */
TournamentManager.prototype.getSpawnPosition = function (discordId, player) {
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] ========================================');
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] getSpawnPosition() called');
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] DiscordId: ' + discordId);
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] Player PID: ' + (player ? player.pID : 'N/A'));
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] PlayerType: ' + (player ? player.playerType : 'N/A'));
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] Tournament State:');
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG]   - isActive: ' + this.isActive);
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG]   - roundStarted: ' + this.roundStarted);
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG]   - isFrozen: ' + this.isFrozen);
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG]   - isPaused: ' + this.isPaused);
    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG]   - nearDeathRespawnEnabled: ' + (this.nearDeathRespawnEnabled !== false));

    // Check if this is a dual player
    if (player && player.playerType === 'DUAL_MINION' && player.ownerPlayer) {
        Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] Player is DUAL_MINION');
        // During active round, use random/near-death spawn
        if (this.roundStarted && !this.isFrozen && !this.isPaused) {
            Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] ✅ Returning NULL - Dual uses NORMAL spawn (round active)');
            Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG]   → FFA.js will handle near-partner spawn');
            Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] ========================================');
            return null; // Use normal random/near-death spawn
        }
        var dualPos = this.getDualSpawnPosition(player);
        Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] 📍 Returning FIXED dual position: (' +
            (dualPos ? Math.floor(dualPos.x) + ', ' + Math.floor(dualPos.y) : 'null') + ')');
        Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] ========================================');
        return dualPos;
    }

    var team = this.getPlayerTeam(discordId);
    var gs = this.gameServer;
    var border = gs.border;

    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] Player team: ' + (team || 'NO TEAM'));

    if (!team) {
        Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] ❌ No team - returning NULL (spectator)');
        Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] ========================================');
        return null;
    }

    // DURING ACTIVE ROUND: Always use random spawn (null return)
    // Near-death spawn is handled by normal game logic if enabled in config
    // Fixed positions are only used during frozen states (reset, round start)
    if (this.roundStarted && !this.isFrozen && !this.isPaused) {
        Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] ✅ Returning NULL - Active round, use NORMAL spawn logic');
        Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG]   → roundStarted=true, isFrozen=false, isPaused=false');
        Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG]   → FFA.js will handle near-death or near-partner spawn');
        Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] ========================================');
        return null; // Return null to use normal spawn logic
    }

    Logger.info('[NEAR-SPAWN-TOURNAMENT-DEBUG] 📍 Calculating FIXED team spawn position (frozen state)');

    // Calculate map center (always 0,0 for centered maps)
    var centerX = (border.minx + border.maxx) / 2;
    var centerY = (border.miny + border.maxy) / 2;

    // Use current border size (accounts for shrinking)
    var mapWidth = border.maxx - border.minx;
    var mapHeight = border.maxy - border.miny;

    // For circular maps, use radius
    if (gs.config.worldIsCircular) {
        mapWidth = gs.config.worldRadius * 2;
        mapHeight = gs.config.worldRadius * 2;
    }

    // Spawn offset from center (25% of map width - closer to center for better gameplay)
    var spawnOffsetX = mapWidth * 0.25;

    // Get FIXED index from registered team list (not dynamic)
    var teamData = this.teams[team];
    var teamPlayersList = teamData.players; // Array of discordIds
    var playerIndex = teamPlayersList.indexOf(String(discordId));
    var totalTeamPlayers = teamPlayersList.length;

    if (playerIndex === -1) return null;

    // Calculate vertical spacing - spread players evenly across 15% of map height (much tighter grouping)
    var usableHeight = mapHeight * 0.15;
    var verticalSpacing = totalTeamPlayers > 1 ? usableHeight / (totalTeamPlayers - 1) : 0;

    // Minimum spacing to prevent overlap (based on player start size)
    var minSpacing = gs.config.playerStartSize * 4 || 500;
    if (verticalSpacing < minSpacing && totalTeamPlayers > 1) {
        verticalSpacing = minSpacing;
    }

    // Calculate starting Y position (centered around map center)
    var startY = centerY - ((totalTeamPlayers - 1) * verticalSpacing / 2);

    var spawnX, spawnY;

    // Calculate Y position for this player
    spawnY = startY + (playerIndex * verticalSpacing);

    // Add small random offset to X to prevent perfect alignment (looks more natural)
    var xJitter = (Math.random() - 0.5) * 200;

    if (team === 'team1') {
        // Team 1 spawns on the LEFT side
        spawnX = centerX - spawnOffsetX + xJitter;
    } else if (team === 'team2') {
        // Team 2 spawns on the RIGHT side
        spawnX = centerX + spawnOffsetX + xJitter;
    } else {
        return null;
    }

    // Clamp to border (safety check)
    var safeMargin = gs.config.playerStartSize * 2 || 200;
    spawnX = Math.max(border.minx + safeMargin, Math.min(border.maxx - safeMargin, spawnX));
    spawnY = Math.max(border.miny + safeMargin, Math.min(border.maxy - safeMargin, spawnY));

    Logger.debug('[TOURNAMENT] Spawn position for player ' + playerIndex + '/' + totalTeamPlayers +
        ' (' + team + '): x=' + Math.floor(spawnX) + ', y=' + Math.floor(spawnY));

    return { x: spawnX, y: spawnY };
};

/**
 * Get spawn position for a dual player (offset from owner)
 * Dual spawns BEHIND the owner (further from center)
 * @param {PlayerTracker} dualPlayer - The dual player tracker
 * @returns {Object} - {x, y} spawn position
 */
TournamentManager.prototype.getDualSpawnPosition = function (dualPlayer) {
    if (!dualPlayer || !dualPlayer.ownerPlayer) return null;

    var owner = dualPlayer.ownerPlayer;
    var ownerDiscordId = owner.discordId;
    var team = this.getPlayerTeam(ownerDiscordId);
    var gs = this.gameServer;

    if (!team) return null;

    // Get owner's position first
    var ownerPos = this.getSpawnPosition(ownerDiscordId, null);
    if (!ownerPos) return null;

    // Offset dual behind owner (further from center)
    // Use player start size to calculate gap - needs to be at least 3x size to not overlap
    var playerSize = this.gameServer.config.playerStartSize || 700;
    var dualOffset = Math.max(800, playerSize * 3);

    return {
        x: team === 'team1' ? ownerPos.x - dualOffset : ownerPos.x + dualOffset,
        y: ownerPos.y
    };
};

/**
 * Get active players in game for a specific team
 * Player is considered "in game" if main OR dual has cells
 */
TournamentManager.prototype.getTeamPlayersInGame = function (teamKey) {
    var players = [];
    var teamData = this.teams[teamKey];

    if (!teamData) return players;

    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var player = client.playerTracker;

        // Case 1: Registered player with discordId
        if (player.discordId && teamData.players.indexOf(String(player.discordId)) !== -1) {
            // Check if main player has cells
            var mainAlive = player.cells && player.cells.length > 0;

            // Check if dual player has cells
            var dualAlive = player.dualPlayer &&
                player.dualPlayer.cells &&
                player.dualPlayer.cells.length > 0;

            if (mainAlive || dualAlive) {
                if (players.indexOf(player) === -1) {
                    players.push(player);
                }
            }
            continue;
        }

        // Case 2: Dual minion - check if owner is on the team
        if (player.playerType === 'DUAL_MINION' && player.ownerPlayer) {
            var ownerDiscordId = player.ownerPlayer.discordId;
            if (ownerDiscordId && teamData.players.indexOf(String(ownerDiscordId)) !== -1) {
                // Dual has cells - owner is considered alive
                if (player.cells && player.cells.length > 0) {
                    if (players.indexOf(player.ownerPlayer) === -1) {
                        players.push(player.ownerPlayer);
                    }
                }
            }
        }
    }

    return players;
};

// ========================================
// FREEZE & UNFREEZE - The clutch moment
// ========================================

/**
 * Start the 3-2-1 countdown before unfreezing
 * @param {PlayerTracker} referee - The referee who initiated
 */
TournamentManager.prototype.startCountdown = function (referee) {
    if (!this.isActive) {
        Logger.warn('[TOURNAMENT-MANAGER] Cannot start countdown - no active tournament');
        return false;
    }

    // Already running - can't start again
    if (this.roundStarted && !this.isFrozen && !this.isPaused) {
        this.broadcastChat('Round already in progress');
        Logger.warn('[TOURNAMENT-MANAGER] Cannot start - round already in progress');
        return false;
    }

    // Can't start if paused - use pause button to resume
    if (this.isPaused) {
        this.broadcastChat('Game is paused - use Pause to resume');
        Logger.warn('[TOURNAMENT-MANAGER] Cannot start - game is paused');
        return false;
    }

    // Not frozen means nothing to unfreeze
    if (!this.isFrozen) {
        Logger.warn('[TOURNAMENT-MANAGER] Cannot start countdown - already unfrozen');
        return false;
    }

    // Check if reset is required (after a round ends)
    if (this.needsReset) {
        this.broadcastChat('⚠️ Press Reset before starting next round!');
        Logger.warn('[TOURNAMENT-MANAGER] Cannot start - reset required first');
        return false;
    }

    // Countdown already running
    if (this.countdownActive) {
        this.broadcastChat('Countdown already in progress');
        Logger.warn('[TOURNAMENT-MANAGER] Countdown already in progress, chill out');
        return false;
    }

    // Cancel any unpause countdown that might be running
    this.unpauseCountdownActive = false;

    this.countdownActive = true;
    this.countdownValue = 3;

    var self = this;

    // Announce countdown
    this.broadcastChat('Round ' + this.currentRound + ' starting...');

    var doCountdown = function () {
        // Check if countdown was cancelled
        if (!self.countdownActive) {
            Logger.info('[TOURNAMENT-MANAGER] Start countdown cancelled');
            return;
        }

        if (self.countdownValue > 0) {
            self.broadcastChat(self.countdownValue + '...');
            self.countdownValue--;
            setTimeout(doCountdown, 1000);
        } else {
            // Countdown finished - UNFREEZE!
            self.countdownActive = false;
            self.isFrozen = false;
            self.roundStarted = true;
            self.lastTimerTick = Date.now();
            self.lastMinuteAnnounced = Math.ceil(self.timeRemaining / 60);

            // Initialize border shrinking if enabled
            self.initBorderShrink();

            self.broadcastChat('GO!');
            self.unfreezeAllPlayers();
            self.broadcastTournamentState();

            // Re-broadcast player info to all clients so skins get hidden
            self.rebroadcastAllPlayerInfo();

            Logger.info('[TOURNAMENT-MANAGER] Round ' + self.currentRound + ' STARTED!');
        }
    };

    setTimeout(doCountdown, 1000);
    return true;
};

/**
 * Freeze all players (pause) - includes dual, bots, and stops eject macro
 */
TournamentManager.prototype.freezeAllPlayers = function () {
    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var player = client.playerTracker;

        // Freeze bots too - they should behave like tournament players
        if (player.isBot) {
            player.frozen = true;
            continue;
        }

        // Freeze tournament players
        if (this.getPlayerTeam(player.discordId)) {
            // Freeze main player
            player.frozen = true;
            player.ejectMacro = false; // Stop ejecting

            // Freeze dual player too
            if (player.dualPlayer) {
                player.dualPlayer.frozen = true;
                player.dualPlayer.ejectMacro = false;
            }
        }
    }
    Logger.debug('[TOURNAMENT-MANAGER] All tournament players and bots frozen');
};

/**
 * Unfreeze all players - includes dual and bots
 */
TournamentManager.prototype.unfreezeAllPlayers = function () {
    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var player = client.playerTracker;

        // Always unfreeze bots - they should move freely
        if (player.isBot) {
            player.frozen = false;
            continue;
        }

        // Unfreeze tournament players
        if (this.getPlayerTeam(player.discordId)) {
            // Unfreeze main player
            player.frozen = false;

            // Unfreeze dual player too
            if (player.dualPlayer) {
                player.dualPlayer.frozen = false;
            }

            // Reset dual spawn tracking for next round
            player._tournamentDualSpawned = false;
        }
    }
    Logger.debug('[TOURNAMENT-MANAGER] All tournament players and bots unfrozen');
};

// ========================================
// PAUSE FUNCTIONALITY
// ========================================

/**
 * Toggle pause state
 */
TournamentManager.prototype.togglePause = function (referee) {
    if (!this.isActive) return false;

    // If unpause countdown is active, cancel it and stay paused
    if (this.unpauseCountdownActive) {
        this.unpauseCountdownActive = false;
        this.broadcastChat('Resume cancelled');
        this.broadcastTournamentState();
        Logger.info('[TOURNAMENT-MANAGER] Resume countdown cancelled');
        return true;
    }

    // If start countdown is active, cancel it
    if (this.countdownActive) {
        this.countdownActive = false;
        this.broadcastChat('Start cancelled');
        this.broadcastTournamentState();
        Logger.info('[TOURNAMENT-MANAGER] Start countdown cancelled via pause');
        return true;
    }

    // Can't pause if frozen (round hasn't started yet)
    if (this.isFrozen && !this.isPaused) {
        this.broadcastChat('Round not started - use Start first');
        Logger.warn('[TOURNAMENT-MANAGER] Cannot pause - round is frozen, not started');
        return false;
    }

    if (this.isPaused) {
        // Unpause - start 3 second countdown
        this.startUnpauseCountdown();
    } else {
        // Pause immediately
        this.isPaused = true;
        this.broadcastChat('Game paused');
        this.freezeAllPlayers();
        this.broadcastTournamentState();
        Logger.info('[TOURNAMENT-MANAGER] Game paused');
    }

    return true;
};

/**
 * Start unpause countdown
 */
TournamentManager.prototype.startUnpauseCountdown = function () {
    var self = this;
    var count = 3;

    this.unpauseCountdownActive = true;

    var doCount = function () {
        // Check if countdown was cancelled (pause pressed again)
        if (!self.unpauseCountdownActive) {
            Logger.info('[TOURNAMENT-MANAGER] Unpause countdown cancelled');
            return;
        }

        if (count > 0) {
            self.broadcastChat('Resuming in ' + count + '...');
            count--;
            setTimeout(doCount, 1000);
        } else {
            self.unpauseCountdownActive = false;
            self.isPaused = false;
            self.unfreezeAllPlayers();
            self.lastTimerTick = Date.now(); // Reset timer reference
            self.broadcastChat('Game resumed');
            self.broadcastTournamentState();
            Logger.info('[TOURNAMENT-MANAGER] Game resumed');
        }
    };

    doCount();
};

// ========================================
// TIMER & TICK - The heartbeat
// ========================================

/**
 * Called every game tick to update tournament state
 */
TournamentManager.prototype.onTick = function () {
    if (!this.isActive) return;

    var currentTick = this.gameServer.tickCounter;

    // Update mass every 5 ticks (200ms)
    if (currentTick - this.lastMassUpdateTick >= 5) {
        this.updateTeamMasses();
        this.lastMassUpdateTick = currentTick;
    }

    // Broadcast state every 25 ticks (1 second)
    if (currentTick - this.lastStateUpdateTick >= 25) {
        this.broadcastTournamentState();
        this.lastStateUpdateTick = currentTick;
    }

    // Timer logic - only if round started and not paused/frozen
    if (this.roundStarted && !this.isPaused && !this.isFrozen) {
        var now = Date.now();
        var elapsed = (now - this.lastTimerTick) / 1000;
        this.lastTimerTick = now;

        this.timeRemaining -= elapsed;

        // Update border shrinking - runs every tick when active
        this.updateBorderShrink(elapsed);

        // Announce minutes remaining
        var minutesLeft = Math.ceil(this.timeRemaining / 60);
        if (minutesLeft !== this.lastMinuteAnnounced && minutesLeft > 0 && minutesLeft <= 10) {
            this.lastMinuteAnnounced = minutesLeft;
            this.broadcastChat(minutesLeft + ' minute' + (minutesLeft > 1 ? 's' : '') + ' left');
        }

        // Time's up!
        if (this.timeRemaining <= 0) {
            this.timeRemaining = 0;
            this.onRoundTimeUp();
        }

        // Check for team elimination (all players dead)
        this.checkTeamElimination();
    }
};

/**
 * Update total mass for each team
 */
TournamentManager.prototype.updateTeamMasses = function () {
    this.teams.team1.totalMass = this.calculateTeamMass('team1');
    this.teams.team2.totalMass = this.calculateTeamMass('team2');
};

/**
 * Calculate total mass for a team (includes dual players)
 */
TournamentManager.prototype.calculateTeamMass = function (teamKey) {
    var totalMass = 0;
    var teamData = this.teams[teamKey];

    if (!teamData) return 0;

    // Track which players we've already counted to avoid duplicates
    var countedPlayers = [];

    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var player = client.playerTracker;

        // Skip if already counted
        if (countedPlayers.indexOf(player) !== -1) continue;

        // Case 1: This is a registered team player (has discordId in team)
        if (player.discordId && teamData.players.indexOf(String(player.discordId)) !== -1) {
            countedPlayers.push(player);

            // Sum main player cells
            for (var j = 0; j < player.cells.length; j++) {
                var cell = player.cells[j];
                if (cell && !cell.isRemoved) {
                    totalMass += cell._mass || 0;
                }
            }

            // Sum dual player cells if exists
            if (player.dualPlayer && player.dualPlayer.cells) {
                countedPlayers.push(player.dualPlayer);
                for (var k = 0; k < player.dualPlayer.cells.length; k++) {
                    var dualCell = player.dualPlayer.cells[k];
                    if (dualCell && !dualCell.isRemoved) {
                        totalMass += dualCell._mass || 0;
                    }
                }
            }
            continue;
        }

        // Case 2: This is a dual minion - check if owner is on the team
        if (player.playerType === 'DUAL_MINION' && player.ownerPlayer) {
            var ownerDiscordId = player.ownerPlayer.discordId;
            if (ownerDiscordId && teamData.players.indexOf(String(ownerDiscordId)) !== -1) {
                // Only count if we haven't counted through owner already
                if (countedPlayers.indexOf(player) === -1) {
                    countedPlayers.push(player);
                    for (var m = 0; m < player.cells.length; m++) {
                        var dualCell2 = player.cells[m];
                        if (dualCell2 && !dualCell2.isRemoved) {
                            totalMass += dualCell2._mass || 0;
                        }
                    }
                }
            }
        }
    }

    return Math.floor(totalMass);
};

// ========================================
// ROUND WIN DETECTION
// ========================================

/**
 * Called when round time runs out
 */
TournamentManager.prototype.onRoundTimeUp = function () {
    Logger.info('[TOURNAMENT-MANAGER] ⏰ Round ' + this.currentRound + ' time up!');

    // Determine winner by mass
    var winner = this.teams.team1.totalMass > this.teams.team2.totalMass ? 'team1' : 'team2';

    if (this.teams.team1.totalMass === this.teams.team2.totalMass) {
        // Tie - sudden death or rematch
        this.broadcastChat('Tied - sudden death');
        this.timeRemaining = 60; // 1 minute sudden death
        return;
    }

    this.endRound(winner, 'timeout');
};

/**
 * Check if a team has been eliminated (all players dead) or fell below min mass
 */
TournamentManager.prototype.checkTeamElimination = function () {
    if (!this.roundStarted) return;

    var team1Alive = this.getTeamPlayersInGame('team1').length > 0;
    var team2Alive = this.getTeamPlayersInGame('team2').length > 0;

    // Check if both teams have spawned at least once
    var team1HasPlayers = this.teams.team1.players.length > 0;
    var team2HasPlayers = this.teams.team2.players.length > 0;

    if (!team1HasPlayers || !team2HasPlayers) return; // Wait for both teams

    // Check for min mass loss (selfeed mode)
    var minLoseMassPercent = this.gameServer.config.minLoseMassPercent || 0;
    if (minLoseMassPercent > 0) {
        var playerStartSize = this.gameServer.config.playerStartSize || 32;
        var startMass = playerStartSize * playerStartSize / 100;
        var minMass = startMass * (minLoseMassPercent / 100);

        // Get team masses (per player average)
        var team1PlayerCount = this.teams.team1.players.length;
        var team2PlayerCount = this.teams.team2.players.length;
        var team1MinTotal = minMass * team1PlayerCount;
        var team2MinTotal = minMass * team2PlayerCount;

        // Check if team1 fell below threshold
        if (this.teams.team1.totalMass < team1MinTotal && this.teams.team1.totalMass > 0) {
            this.endRound('team2', 'minmass');
            return;
        }

        // Check if team2 fell below threshold  
        if (this.teams.team2.totalMass < team2MinTotal && this.teams.team2.totalMass > 0) {
            this.endRound('team1', 'minmass');
            return;
        }
    }

    if (!team1Alive && team2Alive) {
        // Team 1 eliminated
        this.endRound('team2', 'elimination');
    } else if (!team2Alive && team1Alive) {
        // Team 2 eliminated
        this.endRound('team1', 'elimination');
    }
};

/**
 * End the current round with a winner
 * @param {string} winner - 'team1' or 'team2'
 * @param {string} reason - 'timeout' or 'elimination' or 'minmass'
 */
TournamentManager.prototype.endRound = function (winner, reason) {
    if (!this.roundStarted) return;

    this.roundStarted = false;
    this.isFrozen = true;
    this.freezeAllPlayers();

    // Reset border shrinking for next round - fresh start baby!
    this.resetBorderShrink();

    var winnerTeam = this.teams[winner];
    var loserKey = winner === 'team1' ? 'team2' : 'team1';
    var loserTeam = this.teams[loserKey];

    // Convert loser team's cells to dead cells
    this.convertTeamCellsToDeadCells(loserKey);

    // Update score
    winnerTeam.score++;

    // Save to history
    this.roundHistory.push({
        round: this.currentRound,
        winner: winner,
        reason: reason,
        team1Mass: this.teams.team1.totalMass,
        team2Mass: this.teams.team2.totalMass
    });

    // Announce round winner
    var reasonText = reason === 'elimination' ? 'elimination' : (reason === 'minmass' ? 'low mass' : 'time');
    this.broadcastChat(winnerTeam.name + ' won Round ' + this.currentRound + ' (' + reasonText + ')');

    // Send round end notification to clients
    this.broadcastRoundEnd(winner, reason);

    Logger.info('[TOURNAMENT-MANAGER] Round ' + this.currentRound + ' won by ' + winnerTeam.name +
        ' (' + reason + ') - Score: ' + this.teams.team1.score + ' - ' + this.teams.team2.score);

    // Check for match winner
    if (winnerTeam.score >= this.pointsToWin) {
        this.endMatch(winner);
    } else {
        // Prepare next round
        this.currentRound++;
        this.timeRemaining = this.matchDuration;

        // Require reset before starting next round
        this.needsReset = true;

        this.broadcastChat('Round ' + this.currentRound + ' ready - Press Reset first');
        this.broadcastTournamentState();

        // Re-broadcast player info so skins become visible again during frozen state
        this.rebroadcastAllPlayerInfo();
    }
};

/**
 * Convert all cells of a team to dead cells (gray corpses)
 * @param {string} teamKey - 'team1' or 'team2'
 */
TournamentManager.prototype.convertTeamCellsToDeadCells = function (teamKey) {
    var teamData = this.teams[teamKey];
    if (!teamData) return;

    var gs = this.gameServer;
    var convertedCount = 0;

    var clients = gs.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var player = client.playerTracker;

        // Check if this player belongs to the losing team
        var isLosingTeam = player.discordId && teamData.players.indexOf(String(player.discordId)) !== -1;

        if (isLosingTeam) {
            // Convert main player cells
            while (player.cells.length > 0) {
                var cell = player.cells[0];
                if (cell && !cell.isRemoved && gs.convertCellToDeadCell) {
                    gs.convertCellToDeadCell(cell);
                    convertedCount++;
                } else {
                    gs.removeNode(cell);
                }
            }

            // Convert dual player cells too
            if (player.dualPlayer && player.dualPlayer.cells) {
                while (player.dualPlayer.cells.length > 0) {
                    var dualCell = player.dualPlayer.cells[0];
                    if (dualCell && !dualCell.isRemoved && gs.convertCellToDeadCell) {
                        gs.convertCellToDeadCell(dualCell);
                        convertedCount++;
                    } else {
                        gs.removeNode(dualCell);
                    }
                }
            }
        }
    }

    Logger.info('[TOURNAMENT-MANAGER] Converted ' + convertedCount + ' cells from ' + teamData.name + ' to dead cells');
};

/**
 * End the entire match
 */
TournamentManager.prototype.endMatch = function (winner) {
    var winnerTeam = this.teams[winner];

    this.broadcastChat(winnerTeam.name + ' wins the match');
    this.broadcastChat('Final: ' + this.teams.team1.score + ' - ' + this.teams.team2.score);

    // Send match end to clients
    this.broadcastMatchEnd(winner);

    // Reset border to original - match is over
    this.resetBorderShrink();

    Logger.info('[TOURNAMENT-MANAGER] MATCH OVER! ' + winnerTeam.name + ' wins!');

    // Keep isActive true so referee can review, but mark match as ended
    this.matchEnded = true;

    // Re-broadcast player info so skins become visible again
    this.rebroadcastAllPlayerInfo();
};

// ========================================
// REMATCH & SCORE ADJUSTMENT
// ========================================

/**
 * Rematch - revert to previous round state
 */
TournamentManager.prototype.rematch = function () {
    if (!this.isActive) {
        this.broadcastChat('No active tournament');
        return false;
    }

    // Can't rematch during active round - must be frozen or paused
    if (this.roundStarted && !this.isFrozen && !this.isPaused) {
        this.broadcastChat('Cannot rematch during active round - pause first');
        Logger.warn('[TOURNAMENT-MANAGER] Cannot rematch - round in progress');
        return false;
    }

    // Cancel any countdowns
    if (this.countdownActive) {
        this.countdownActive = false;
        Logger.info('[TOURNAMENT-MANAGER] Countdown cancelled for rematch');
    }
    if (this.unpauseCountdownActive) {
        this.unpauseCountdownActive = false;
        Logger.info('[TOURNAMENT-MANAGER] Unpause countdown cancelled for rematch');
    }

    if (this.roundHistory.length === 0) {
        this.broadcastChat('No round to revert');
        return false;
    }

    var lastRound = this.roundHistory.pop();

    // Revert score
    if (lastRound.winner === 'team1') {
        this.teams.team1.score--;
    } else {
        this.teams.team2.score--;
    }

    // Reset round state
    this.currentRound = lastRound.round;
    this.timeRemaining = this.matchDuration;
    this.isFrozen = true;
    this.isPaused = false; // Clear pause state
    this.roundStarted = false;
    this.matchEnded = false;

    this.broadcastChat('Rematch - Round ' + this.currentRound);
    this.broadcastChat('Score: ' + this.teams.team1.score + ' - ' + this.teams.team2.score);
    this.broadcastTournamentState();

    // Reset player positions
    this.resetPlayerSpawns();

    Logger.info('[TOURNAMENT-MANAGER] Rematch called - replaying round ' + this.currentRound);
    return true;
};

/**
 * Set score directly (from Discord bot command)
 */
TournamentManager.prototype.setScore = function (team1Score, team2Score) {
    this.teams.team1.score = team1Score;
    this.teams.team2.score = team2Score;

    this.broadcastChat('Score: ' + team1Score + ' - ' + team2Score);
    this.broadcastTournamentState();

    Logger.info('[TOURNAMENT-MANAGER] Score manually set to ' + team1Score + ' - ' + team2Score);
};

/**
 * Set timer duration (from client UI)
 */
TournamentManager.prototype.setTimer = function (minutes) {
    this.matchDuration = minutes * 60;

    if (!this.roundStarted) {
        this.timeRemaining = this.matchDuration;
    }

    this.broadcastChat('Timer: ' + minutes + 'm');
    this.broadcastTournamentState();

    Logger.info('[TOURNAMENT-MANAGER] Timer set to ' + minutes + ' minutes');
};

/**
 * Set points to win (rounds needed)
 */
TournamentManager.prototype.setPointsToWin = function (points) {
    this.pointsToWin = Math.max(1, Math.min(10, points));
    this.broadcastChat('First to ' + this.pointsToWin + ' wins');
    this.broadcastTournamentState();
    Logger.info('[TOURNAMENT-MANAGER] Points to win set to ' + this.pointsToWin);
};

/**
 * Set respawn cooldown duration
 */
TournamentManager.prototype.setRespawnCooldown = function (seconds) {
    this.respawnCooldownDuration = Math.max(0, Math.min(30, seconds));
    this.broadcastChat('Respawn cooldown: ' + this.respawnCooldownDuration + 's');
    this.broadcastTournamentState();
    Logger.info('[TOURNAMENT-MANAGER] Respawn cooldown set to ' + this.respawnCooldownDuration + 's');
};

/**
 * Set bot count dynamically
 * If count > 0: Adds exactly 'count' bots to the game
 * If count = 0: Removes ALL bots from the game
 */
TournamentManager.prototype.setBots = function (count) {
    count = Math.max(0, Math.min(50, count)); // Limit between 0 and 50

    // Count current bots first
    var botClients = [];
    for (var i = 0; i < this.gameServer.clients.length; i++) {
        var client = this.gameServer.clients[i];
        if (!client || !client.playerTracker) continue;

        // Check if it's a bot (BotPlayer sets isBot = true)
        if (client.playerTracker.isBot === true) {
            botClients.push(client);
        }
    }

    var currentBots = botClients.length;

    // If 0, remove ALL bots
    if (count === 0) {
        if (currentBots === 0) {
            this.broadcastChat('No bots to remove');
            return;
        }

        // Remove all bots
        for (var i = botClients.length - 1; i >= 0; i--) {
            var client = botClients[i];
            if (!client) continue;

            // Remove player cells
            if (client.playerTracker && client.playerTracker.cells) {
                while (client.playerTracker.cells.length > 0) {
                    this.gameServer.removeNode(client.playerTracker.cells[0]);
                }
            }

            // Remove from clients array
            var idx = this.gameServer.clients.indexOf(client);
            if (idx !== -1) {
                this.gameServer.clients.splice(idx, 1);
            }

            // Close socket
            try {
                if (client.close && typeof client.close === 'function') {
                    client.close();
                }
            } catch (e) { }
        }

        this.gameServer.config.serverBots = 0;
        this.broadcastChat('Removed all ' + currentBots + ' bots');
        Logger.info('[TOURNAMENT-MANAGER] Removed all ' + currentBots + ' bots');
        return;
    }

    // Add exactly 'count' bots
    for (var i = 0; i < count; i++) {
        this.gameServer.bots.addBot();
    }

    this.gameServer.config.serverBots = currentBots + count;
    this.broadcastChat('Added ' + count + ' bots (total: ' + (currentBots + count) + ')');
    Logger.info('[TOURNAMENT-MANAGER] Added ' + count + ' bots (total: ' + (currentBots + count) + ')');
};

/**
 * Toggle spectator chat filter
 * When ON: Tournament players can't see spectator messages during rounds
 * When OFF or round ended: Everyone sees all messages
 */
TournamentManager.prototype.toggleChatFilter = function () {
    this.filterSpectatorChat = !this.filterSpectatorChat;

    if (this.filterSpectatorChat) {
        this.broadcastChat('Spectator chat hidden from players');
    } else {
        this.broadcastChat('Spectator chat visible to all');
    }

    this.broadcastTournamentState();

    Logger.info('[TOURNAMENT-MANAGER] Spectator chat filter: ' + (this.filterSpectatorChat ? 'ON' : 'OFF'));
    return this.filterSpectatorChat;
};

/**
 * Toggle near-death respawn
 * When ON: Players respawn near their death position during active rounds
 * When OFF: Players always respawn at fixed team positions
 */
TournamentManager.prototype.toggleNearDeathRespawn = function () {
    this.nearDeathRespawnEnabled = !this.nearDeathRespawnEnabled;

    if (this.nearDeathRespawnEnabled) {
        this.broadcastChat('Near-death respawn: ON');
    } else {
        this.broadcastChat('Near-death respawn: OFF (random positions)');
    }

    this.broadcastTournamentState();

    Logger.info('[TOURNAMENT-MANAGER] Near-death respawn: ' + (this.nearDeathRespawnEnabled ? 'ON' : 'OFF'));
    return this.nearDeathRespawnEnabled;
};

/**
 * Check if player can respawn (cooldown check)
 * @param {string} discordId - Player's Discord ID
 * @returns {Object} - {canRespawn: boolean, remainingTime: number}
 */
TournamentManager.prototype.checkRespawnCooldown = function (discordId) {
    if (!discordId) return { canRespawn: true, remainingTime: 0 };

    // No cooldown during frozen state (reset, between rounds)
    if (this.isFrozen || !this.roundStarted) {
        return { canRespawn: true, remainingTime: 0 };
    }

    var now = Date.now();
    var cooldownEnd = this.respawnCooldowns[discordId] || 0;

    if (now < cooldownEnd) {
        var remainingMs = cooldownEnd - now;
        return { canRespawn: false, remainingTime: remainingMs / 1000 };
    }

    return { canRespawn: true, remainingTime: 0 };
};

/**
 * Start respawn cooldown for a player
 * @param {string} discordId - Player's Discord ID
 */
TournamentManager.prototype.startRespawnCooldown = function (discordId) {
    if (!discordId) return;

    // Only apply cooldown during active round
    if (!this.roundStarted || this.isFrozen) return;

    var now = Date.now();
    this.respawnCooldowns[discordId] = now + (this.respawnCooldownDuration * 1000);

    Logger.debug('[TOURNAMENT-MANAGER] Respawn cooldown started for ' + discordId + ': ' + this.respawnCooldownDuration + 's');
};

/**
 * Clear respawn cooldown for a player
 * @param {string} discordId - Player's Discord ID
 */
TournamentManager.prototype.clearRespawnCooldown = function (discordId) {
    if (discordId && this.respawnCooldowns[discordId]) {
        delete this.respawnCooldowns[discordId];
    }
};

/**
 * Clear all respawn cooldowns
 */
TournamentManager.prototype.clearAllRespawnCooldowns = function () {
    this.respawnCooldowns = {};
    Logger.debug('[TOURNAMENT-MANAGER] All respawn cooldowns cleared');
};

/**
 * Reset all players to spawn positions with default size
 * Used for rematch and round reset
 * Position is determined by getSpawnPosition using fixed index from registered team
 * Also respawns dual players next to their owners
 */
TournamentManager.prototype.resetPlayerSpawns = function () {
    if (!this.isActive) {
        this.broadcastChat('No active tournament');
        return false;
    }

    // Can't reset during active round - must be frozen or paused first
    if (this.roundStarted && !this.isFrozen && !this.isPaused) {
        this.broadcastChat('Cannot reset during active round - pause first');
        Logger.warn('[TOURNAMENT-MANAGER] Cannot reset spawns - round in progress');
        return false;
    }

    // Cancel any countdowns
    if (this.countdownActive) {
        this.countdownActive = false;
        this.broadcastChat('Countdown cancelled');
        Logger.info('[TOURNAMENT-MANAGER] Countdown cancelled for reset');
    }
    if (this.unpauseCountdownActive) {
        this.unpauseCountdownActive = false;
        this.broadcastChat('Resume cancelled');
        Logger.info('[TOURNAMENT-MANAGER] Unpause countdown cancelled for reset');
    }

    // Make sure we're in frozen state after reset
    this.isFrozen = true;
    this.isPaused = false;
    this.roundStarted = false;
    this.needsReset = false;  // Reset requirement cleared!

    // Reset border shrinking to original state
    this.resetBorderShrink();

    // Clear and re-add bots
    this._resetBots();

    var gs = this.gameServer;
    var clients = gs.clients;
    var resetCount = 0;
    var dualCount = 0;
    var skippedCount = 0;

    // Track spawn counts per team to enforce team size limits
    var teamSpawnCounts = {
        team1: 0,
        team2: 0
    };

    // Dual offset - spawn dual far enough behind main player to not overlap
    // Use player start size to calculate gap - needs to be at least 3x size
    var playerSize = gs.config.playerStartSize || 700;
    var dualOffset = Math.max(800, playerSize * 3);

    // First pass: Remove all cells from team players (even those that won't respawn)
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var player = client.playerTracker;
        var team = this.getPlayerTeam(player.discordId);

        if (!team) continue; // Skip spectators

        // Remove all main player cells
        while (player.cells.length > 0) {
            gs.removeNode(player.cells[0]);
        }

        // Remove dual player cells too
        var hasDual = player.dualPlayer && player.dualPlayer.cells;
        if (hasDual) {
            while (player.dualPlayer.cells.length > 0) {
                gs.removeNode(player.dualPlayer.cells[0]);
            }
        }

        // Reset dual spawn tracking - allow one spawn during this reset
        player._tournamentDualSpawned = false;
    }

    // Second pass: Spawn players respecting team size limits
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var player = client.playerTracker;
        var team = this.getPlayerTeam(player.discordId);

        if (!team) continue; // Skip spectators

        // Check team size limit BEFORE spawning
        if (this.teamSizeLimit > 0) {
            // Calculate how many slots this spawn would take (main + dual = 2 slots)
            var slotsNeeded = 1; // Main player
            if (player.dualPlayer) {
                slotsNeeded = 2; // Main + dual
            }

            var currentTeamCount = teamSpawnCounts[team];
            var afterSpawnCount = currentTeamCount + slotsNeeded;

            // Skip if spawning would exceed team limit
            if (afterSpawnCount > this.teamSizeLimit) {
                Logger.info('[TOURNAMENT-MANAGER] ⛔ Skipping player ' + player._name +
                    ' (discordId=' + player.discordId + ') - Team ' + team + ' is full (' +
                    currentTeamCount + '/' + this.teamSizeLimit + ')');
                skippedCount++;
                continue;
            }
        }

        // Get spawn position for main player
        var mainPos = this.getSpawnPosition(player.discordId);
        if (!mainPos) continue;

        // Spawn main player
        player.frozen = true;
        player.ejectMacro = false;
        gs.spawnPlayer(player, mainPos, { forceTournamentPosition: true });
        resetCount++;
        teamSpawnCounts[team]++;

        // Spawn dual player if exists AND there's room
        if (player.dualPlayer) {
            // Check if there's still room for dual (counts as +1 slot)
            if (this.teamSizeLimit > 0 && teamSpawnCounts[team] >= this.teamSizeLimit) {
                Logger.info('[TOURNAMENT-MANAGER] ⛔ Skipping dual for ' + player._name +
                    ' - Team ' + team + ' is full after main spawn');
            } else {
                player.dualPlayer.frozen = true;
                player.dualPlayer.ejectMacro = false;

                // Calculate dual position - behind main player (further from center)
                var dualPos = {
                    x: team === 'team1' ? mainPos.x - dualOffset : mainPos.x + dualOffset,
                    y: mainPos.y
                };

                // Spawn dual at offset position
                gs.spawnPlayer(player.dualPlayer, dualPos, { forceTournamentPosition: true });
                dualCount++;
                teamSpawnCounts[team]++;
            }
        }
    }

    if (skippedCount > 0) {
        Logger.info('[TOURNAMENT-MANAGER] ⚠️ Skipped ' + skippedCount + ' players due to team size limit (' +
            this.teamSizeLimit + ' per team)');
    }

    this.broadcastChat('Players reset');
    this.broadcastTournamentState();
    Logger.info('[TOURNAMENT-MANAGER] Reset ' + resetCount + ' players, ' + dualCount + ' duals');
    return true;
};

// ========================================
// NETWORK - Packet broadcasting
// ========================================

/**
 * Broadcast tournament state to all clients (Opcode 52)
 */
TournamentManager.prototype.broadcastTournamentState = function () {
    var state = {
        isActive: this.isActive,
        isFrozen: this.isFrozen,
        isPaused: this.isPaused,
        roundStarted: this.roundStarted,
        currentRound: this.currentRound,
        pointsToWin: this.pointsToWin,
        timeRemaining: Math.ceil(this.timeRemaining),
        matchDuration: this.matchDuration,
        filterSpectatorChat: this.filterSpectatorChat,
        nearDeathRespawnEnabled: this.nearDeathRespawnEnabled,
        respawnCooldownDuration: this.respawnCooldownDuration,
        team1: {
            name: this.teams.team1.name,
            score: this.teams.team1.score,
            totalMass: this.teams.team1.totalMass,
            color: this.teams.team1.color,
            playerCount: this.teams.team1.players.length
        },
        team2: {
            name: this.teams.team2.name,
            score: this.teams.team2.score,
            totalMass: this.teams.team2.totalMass,
            color: this.teams.team2.color,
            playerCount: this.teams.team2.players.length
        }
    };

    // Send to all connected clients
    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.packetHandler) continue;

        // Check if client is a referee
        var isReferee = false;
        if (client.playerTracker) {
            isReferee = this.isReferee(client.playerTracker);
        }

        // Include referee flag and player's team info
        var playerTeam = null;
        if (client.playerTracker && client.playerTracker.discordId) {
            playerTeam = this.getPlayerTeam(client.playerTracker.discordId);
        }

        state.isReferee = isReferee;
        state.playerTeam = playerTeam;

        if (client.packetHandler.sendTournamentState) {
            client.packetHandler.sendTournamentState(state);
        }
    }
};

/**
 * Broadcast round end notification
 */
TournamentManager.prototype.broadcastRoundEnd = function (winner, reason) {
    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.packetHandler) continue;

        if (client.packetHandler.sendTournamentRoundEnd) {
            client.packetHandler.sendTournamentRoundEnd({
                winner: winner,
                winnerName: this.teams[winner].name,
                reason: reason,
                round: this.currentRound,
                team1Score: this.teams.team1.score,
                team2Score: this.teams.team2.score
            });
        }
    }
};

/**
 * Broadcast match end notification
 */
TournamentManager.prototype.broadcastMatchEnd = function (winner) {
    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.packetHandler) continue;

        if (client.packetHandler.sendTournamentMatchEnd) {
            client.packetHandler.sendTournamentMatchEnd({
                winner: winner,
                winnerName: this.teams[winner].name,
                team1Score: this.teams.team1.score,
                team2Score: this.teams.team2.score,
                team1Name: this.teams.team1.name,
                team2Name: this.teams.team2.name
            });
        }
    }
};

/**
 * Send chat message to everyone
 */
TournamentManager.prototype.broadcastChat = function (message) {
    this.gameServer.sendChatToAll(message);
};

// ========================================
// REFEREE COMMANDS (called from PacketHandler)
// ========================================

/**
 * Handle referee command from client
 * @param {PlayerTracker} player - The player sending command
 * @param {string} command - Command type
 * @param {Object} data - Command data
 */
TournamentManager.prototype.handleRefereeCommand = function (player, command, data) {
    if (!this.isReferee(player)) {
        Logger.warn('[TOURNAMENT-MANAGER] Non-referee tried to use command: ' + command);
        return false;
    }

    Logger.info('[TOURNAMENT-MANAGER] Referee command: ' + command);

    switch (command) {
        case 'unfreeze':
        case 'start':
            return this.startCountdown(player);

        case 'pause':
            return this.togglePause(player);

        case 'rematch':
            return this.rematch();

        case 'resetSpawn':
            return this.resetPlayerSpawns();

        case 'filterChat':
            return this.toggleChatFilter();

        case 'nearDeathRespawn':
            return this.toggleNearDeathRespawn();

        case 'setTimer':
            if (data && data.minutes) {
                this.setTimer(data.minutes);
                return true;
            }
            return false;

        case 'setRounds':
            if (data && data.rounds) {
                this.setPointsToWin(data.rounds);
                return true;
            }
            return false;

        case 'setRespawnCooldown':
            if (data && typeof data.seconds === 'number') {
                this.setRespawnCooldown(data.seconds);
                return true;
            }
            return false;

        case 'setBots':
            if (data && typeof data.bots === 'number') {
                this.setBots(data.bots);
                return true;
            }
            return false;

        case 'setScore':
            if (data && typeof data.team1 === 'number' && typeof data.team2 === 'number') {
                this.setScore(data.team1, data.team2);
                return true;
            }
            return false;

        default:
            Logger.warn('[TOURNAMENT-MANAGER] Unknown referee command: ' + command);
            return false;
    }
};

// ========================================
// BORDER SHRINKING - The arena gets smaller and shit gets real
// ========================================

/**
 * Initialize border shrinking for a new round
 * Called fresh each round - border resets to original and starts shrinking again
 */
TournamentManager.prototype.initBorderShrink = function () {
    var gs = this.gameServer;
    var config = gs.config;

    // Only init if border shrinking is enabled
    if (!config.borderShrinkEnabled) {
        this.borderShrinkActive = false;
        return;
    }

    // Store original border size from gameServer's saved original
    if (config.worldIsCircular) {
        this.originalBorderSize = gs.originalBorder ? gs.originalBorder.radius : config.worldRadius;
        this.currentBorderSize = this.originalBorderSize; // Start fresh from original!
    } else {
        this.originalBorderSize = gs.originalBorder ? Math.min(gs.originalBorder.width, gs.originalBorder.height) : Math.min(gs.border.width, gs.border.height);
        this.currentBorderSize = this.originalBorderSize; // Start fresh from original!
    }

    this.borderShrinkActive = true;
    this.lastBorderUpdateTick = gs.tickCounter;
    this._borderMinAnnounced = false; // Reset min announced flag

    Logger.info('[TOURNAMENT-BORDER] Border shrinking started. Size: ' + this.originalBorderSize);
};

/**
 * Update border shrinking - called every tick during active round
 * @param {number} elapsed - Seconds since last tick
 */
TournamentManager.prototype.updateBorderShrink = function (elapsed) {
    var gs = this.gameServer;
    var config = gs.config;

    // Skip if not enabled or not active
    if (!config.borderShrinkEnabled || !this.borderShrinkActive) return;

    // Don't shrink if paused or frozen
    if (this.isPaused || this.isFrozen) return;

    // Calculate shrink amount for this tick
    var shrinkAmount = config.borderShrinkSpeed * elapsed;

    // Calculate new border size
    var newSize = this.currentBorderSize - shrinkAmount;
    var minSize = config.borderShrinkMinSize;

    // Don't shrink below minimum
    if (newSize <= minSize) {
        newSize = minSize;
        // Stop shrinking when we hit minimum (only announce once)
        if (this.currentBorderSize > minSize && !this._borderMinAnnounced) {
            this.broadcastChat('Border at minimum size');
            this._borderMinAnnounced = true;
        }
    }

    this.currentBorderSize = newSize;

    // Throttle border updates to clients - only send every 10 ticks (~400ms)
    // This prevents console spam and potential client crashes
    var currentTick = gs.tickCounter;
    if (currentTick - this.lastBorderUpdateTick < 10) return;
    this.lastBorderUpdateTick = currentTick;

    // Update the actual game border
    if (config.worldIsCircular) {
        // Circular map - update radius and matching rectangular bounds
        var newWidth = newSize * 2;
        var newHeight = newSize * 2;
        gs.updateBorderSize(newWidth, newHeight, newSize);
    } else {
        // Rectangular map - shrink proportionally
        var ratio = newSize / this.originalBorderSize;
        var newWidth = gs.originalBorder.width * ratio;
        var newHeight = gs.originalBorder.height * ratio;
        gs.updateBorderSize(newWidth, newHeight);
    }
};

/**
 * Reset border shrinking (restore original border)
 * Only called on FULL tournament reset or match end - NOT between rounds!
 */
TournamentManager.prototype.resetBorderShrink = function () {
    var gs = this.gameServer;

    // Reset to original border
    if (gs.resetBorderToOriginal) {
        gs.resetBorderToOriginal();
    }

    // Reset state
    this.borderShrinkActive = false;
    this.currentBorderSize = this.originalBorderSize;
    this._borderMinAnnounced = false; // Reset the "minimum reached" flag

    Logger.info('[TOURNAMENT-BORDER] Border reset to original size');
};

/**
 * Pause border shrinking (but don't reset)
 */
TournamentManager.prototype.pauseBorderShrink = function () {
    // Border shrinking automatically pauses when isPaused or isFrozen is true
    // This is just for explicit pause if needed
    Logger.debug('[TOURNAMENT-BORDER] Border shrinking paused');
};

/**
 * Resume border shrinking from where it was
 */
TournamentManager.prototype.resumeBorderShrink = function () {
    // Border shrinking automatically resumes when game unpauses/unfreezes
    Logger.debug('[TOURNAMENT-BORDER] Border shrinking resumed');
};

/**
 * Get current border percentage (for UI display)
 * @returns {number} - Percentage of original border size remaining
 */
TournamentManager.prototype.getBorderPercentage = function () {
    if (this.originalBorderSize <= 0) return 100;
    return Math.floor((this.currentBorderSize / this.originalBorderSize) * 100);
};

module.exports = TournamentManager;

