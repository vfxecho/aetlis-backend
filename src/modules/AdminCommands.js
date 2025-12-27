// AdminCommands.js - Extended admin commands for in-game administration
// Based on main.js client commands with server-side implementation

var Logger = require('./Logger');
var UserRoleEnum = require("../enum/UserRoleEnum");
var Entity = require('../entity');

var DEFAULT_TROLL_IMAGE = 'https://cdn.neoldu.com.tr/news/63518.jpg';
var DEFAULT_TROLL_DURATION = 4000;
var MIN_TROLL_DURATION = 500;
var MAX_TROLL_DURATION = 20000;

function clamp(value, min, max, fallback) {
    if (typeof value !== 'number' || isNaN(value)) return fallback;
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function AdminCommands() {
    this.list = {};
}

module.exports = AdminCommands;

// Helper function to get player by ID
function getPlayerById(gameServer, playerId) {
    playerId = parseInt(playerId);
    if (isNaN(playerId)) return null;

    for (var i = 0; i < gameServer.clients.length; i++) {
        var client = gameServer.clients[i];
        if (client && client.playerTracker && client.playerTracker.pID === playerId) {
            return client.playerTracker;
        }
    }
    return null;
}

function ensureTournamentAvailable(gameServer, player) {
    if (player.userRole < UserRoleEnum.ADMIN) {
        return "ERROR: Access denied!";
    }
    if (!gameServer.tournamentManager) {
        return "ERROR: Tournament system unavailable.";
    }
    return null;
}

function startTournamentCommand(gameServer, player, args, immediate) {
    var accessError = ensureTournamentAvailable(gameServer, player);
    if (accessError) return accessError;

    var minutes = 0;
    if (!immediate) {
        minutes = parseInt(args, 10);
        if (isNaN(minutes) || minutes < 0) {
            return "Usage: /start-tournament <minutes>";
        }
    }

    try {
        gameServer.tournamentManager.start(immediate ? 0 : minutes);
    } catch (err) {
        Logger.error('[TOURNAMENT] Failed to start: ' + err.message);
        return "ERROR: " + err.message;
    }

    if (immediate) {
        return "✓ Tournament queue started";
    }
    return "✓ Tournament countdown started for " + minutes + " minute(s)";
}

// Admin Commands List (from main.js)
AdminCommands.list = {

    // TROLL OVERLAY
    troll: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.ADMIN) {
            return "ERROR: Access denied!";
        }

        var cleaned = (args || "").trim();
        if (!cleaned) {
            return "Usage: /troll <PlayerID> [imageUrl] [audioUrl] [durationMs]";
        }

        var parts = cleaned.split(/\s+/);
        var targetPlayer = getPlayerById(gameServer, parts[0]);
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        var imageUrl = parts.length > 1 ? parts[1] : DEFAULT_TROLL_IMAGE;
        var audioUrl = parts.length > 2 ? parts[2] : "";
        var durationRaw = parts.length > 3 ? parseInt(parts[3], 10) : DEFAULT_TROLL_DURATION;
        var durationMs = clamp(durationRaw, MIN_TROLL_DURATION, MAX_TROLL_DURATION, DEFAULT_TROLL_DURATION);

        var payloadObject = {
            image: imageUrl,
            audio: audioUrl,
            duration: durationMs
        };

        var encodedPayload;
        try {
            encodedPayload = Buffer.from(JSON.stringify(payloadObject), 'utf8').toString('base64');
        } catch (err) {
            Logger.error("Failed to encode troll payload: " + err.message);
            return "ERROR: Failed to prepare troll payload";
        }

        var fullPayload = "TROLL|" + encodedPayload;
        gameServer.sendChatMessage(null, targetPlayer, fullPayload);

        Logger.info("ADMIN: " + player._name + " triggered troll overlay for player " + targetPlayer.pID);
        return { silent: true, message: "✓ Troll activated for player " + targetPlayer.pID };
    },

    // MASS MANIPULATION
    mass: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.MODER) {
            return "ERROR: Access denied! Login as admin first.";
        }

        var split = args.split(' ');
        if (split.length < 2) {
            return "Usage: /mass [PlayerID] [+/-]amount";
        }

        var targetPlayer = getPlayerById(gameServer, split[0]);
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        var massChange = parseFloat(split[1]);
        if (isNaN(massChange)) {
            return "ERROR: Invalid mass value";
        }

        // Apply mass to all cells
        for (var i = 0; i < targetPlayer.cells.length; i++) {
            var cell = targetPlayer.cells[i];
            var currentMass = cell._mass;
            var newMass;

            if (split[1][0] === '+' || split[1][0] === '-') {
                // Relative change
                newMass = Math.max(10, currentMass + massChange);
            } else {
                // Absolute value
                newMass = Math.max(10, massChange);
            }

            var newSize = Math.sqrt(newMass * 100);
            cell.setSize(newSize);
        }

        Logger.info("ADMIN: " + player._name + " changed mass of player " + targetPlayer.pID + " to " + massChange);
        return ""; // No message - completely silent
    },

    // TELEPORT
    // Teleporter role (1446028475470446654) can only use this in tournament servers
    teleport: function (gameServer, player, args) {
        var isTournamentMode = gameServer.tournamentManager && gameServer.tournamentManager.isActive;

        // Check access - Teleporter role only works in tournament mode
        if (player.isTeleporter && !isTournamentMode) {
            return "ERROR: Teleporter role only works in tournament servers!";
        }

        // Allow if: MODER+, or Teleporter in tournament mode
        var hasAccess = player.userRole >= UserRoleEnum.MODER ||
            (player.isTeleporter && isTournamentMode);

        if (!hasAccess) {
            return "ERROR: Access denied!";
        }

        var split = args.split(' ');
        if (split.length < 3) {
            return "Usage: /teleport [PlayerID] [X] [Y]";
        }

        var targetPlayer = getPlayerById(gameServer, split[0]);
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        var x = parseFloat(split[1]);
        var y = parseFloat(split[2]);

        if (isNaN(x) || isNaN(y)) {
            return "ERROR: Invalid coordinates";
        }

        // Calculate total mass from all cells
        var totalMass = 0;
        for (var i = 0; i < targetPlayer.cells.length; i++) {
            totalMass += targetPlayer.cells[i]._mass;
        }

        // Copy cells array to avoid modification during iteration
        var cellsToRemove = targetPlayer.cells.slice(1); // All cells except first

        // Remove all cells except the first one
        for (var i = 0; i < cellsToRemove.length; i++) {
            var cellToRemove = cellsToRemove[i];
            gameServer.removeNode(cellToRemove);
        }

        // Teleport and set mass to the remaining cell
        if (targetPlayer.cells.length > 0) {
            var cell = targetPlayer.cells[0];
            cell.position.x = x;
            cell.position.y = y;

            // Set the total mass
            var newSize = Math.sqrt(totalMass * 100);
            cell.setSize(newSize);

            gameServer.updateNodeQuad(cell);
        }

        Logger.info("[TP] " + player._name + " teleported " + targetPlayer._name + " to (" + x + "," + y + ")");
        return ""; // No message - completely silent
    },

    // TP alias
    tp: function (gameServer, player, args) {
        return this.teleport(gameServer, player, args);
    },

    // FREEZE/UNFREEZE
    freeze: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.MODER) {
            return "ERROR: Access denied!";
        }

        var targetPlayer = getPlayerById(gameServer, args.trim());
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        targetPlayer.frozen = !targetPlayer.frozen;

        var action = targetPlayer.frozen ? "froze" : "unfroze";
        Logger.info("ADMIN: " + player._name + " " + action + " player " + targetPlayer.pID);

        // Broadcast to all players
        var broadcastMsg = "⚠️ " + targetPlayer._name + " has been " + action + " by admin";
        gameServer.sendChatMessage(null, null, broadcastMsg);

        return { silent: true, message: "✓ Player " + action };
    },

    // SPAWN VIRUS AT LOCATION
    virus: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.ADMIN) {
            return "ERROR: Access denied!";
        }

        var split = args.split(' ');
        if (split.length < 2) {
            return "Usage: /virus [X] [Y]";
        }

        var x = parseFloat(split[0]);
        var y = parseFloat(split[1]);

        if (isNaN(x) || isNaN(y)) {
            return "ERROR: Invalid coordinates";
        }

        var pos = { x: x, y: y };
        var virus = new Entity.Virus(gameServer, null, pos, gameServer.config.virusMinSize);
        gameServer.addNode(virus);

        Logger.info("ADMIN: " + player._name + " spawned virus at (" + x + "," + y + ")");
        return { silent: true, message: "✓ Virus spawned" };
    },

    // KICK PLAYER
    kick: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.MODER) {
            return "ERROR: Access denied!";
        }

        var targetPlayer = getPlayerById(gameServer, args.trim());
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        if (targetPlayer === player) {
            return "ERROR: Cannot kick yourself!";
        }

        var targetName = targetPlayer._name;
        Logger.warn("ADMIN KICK: " + player._name + " kicked " + targetName + " (ID: " + targetPlayer.pID + ")");

        if (targetPlayer.socket && targetPlayer.socket.isConnected) {
            targetPlayer.socket.close(1000, "Kicked by admin");
        }

        // Broadcast to all players
        var broadcastMsg = "⚠️ " + targetName + " was kicked by admin";
        gameServer.sendChatMessage(null, null, broadcastMsg);

        return { silent: true, message: "✓ Player kicked" };
    },

    // REMOVED - Duplicate definition below with Discord ban support

    // MUTE PLAYER (temporary IP mute until server restart)
    mute: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.MODER) {
            return "ERROR: Access denied!";
        }

        var targetPlayer = getPlayerById(gameServer, args.trim());
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        targetPlayer.isMuted = !targetPlayer.isMuted;

        var action = targetPlayer.isMuted ? "muted" : "unmuted";
        Logger.info('[MUTE] ADMIN:', player._name, action, 'player', targetPlayer.pID, '(temporary - until restart)');

        // Broadcast to all players
        var broadcastMsg = "🔇 " + targetPlayer._name + " has been " + action + " by admin (until restart)";
        gameServer.sendChatMessage(null, null, broadcastMsg);

        return { silent: true, message: "✓ Player " + action + " (temporary)" };
    },

    // MUTE ACCOUNT (permanent Discord account mute with database persistence)
    muteaccount: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.ADMIN) {
            return "ERROR: Access denied!";
        }

        var split = args.split(' ');
        if (split.length < 2) {
            return "Usage: /muteaccount [PlayerID] [hours] (0 = unmute)";
        }

        var targetPlayer = getPlayerById(gameServer, split[0]);
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        var hours = parseInt(split[1]);
        if (isNaN(hours) || hours < 0) {
            return "ERROR: Invalid hours value";
        }

        if (hours > 100000) hours = 100000;

        // Check if player is logged in
        if (!targetPlayer.discordId) {
            // Fallback to temporary mute (no database)
            targetPlayer.isMuted = true;
            targetPlayer.muteExpireTime = hours > 0 ? Date.now() + (hours * 60 * 60 * 1000) : null;

            Logger.warn('[MUTE] ⚠️ Player not logged in - temporary mute only');
            gameServer.sendChatMessage(null, null, "🔇 " + targetPlayer._name + " muted (temporary - until restart)");

            return { silent: true, message: "⚠️ Player not logged in - temporary mute only" };
        }

        // Player is logged in - mute via API (permanent)
        var https = require('https');

        if (hours === 0) {
            // Unmute
            var postDataUnmute = JSON.stringify({
                discordId: targetPlayer.discordId,
                adminDiscordId: player.discordId || null,
                gameServerKey: 'aetlis-gs-mod-2024-xK9mP2vL8nQ4'
            });

            var optionsUnmute = {
                hostname: 'aetlis.io',
                port: 443,
                path: '/api/game/unmute',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postDataUnmute)
                }
            };

            var reqUnmute = https.request(optionsUnmute, function (res) {
                var body = '';
                res.on('data', function (chunk) { body += chunk; });
                res.on('end', function () {
                    if (res.statusCode === 200) {
                        Logger.info('[MUTE] ✅ Discord account unmute SUCCESS!');
                        targetPlayer.isMuted = false;
                        targetPlayer.muteExpireTime = null;
                    } else {
                        Logger.error('[MUTE] ❌ Discord account unmute FAILED! Status:', res.statusCode, 'Response:', body);
                    }
                });
            });

            reqUnmute.on('error', function (err) {
                Logger.error('[MUTE] ❌ API request error:', err.message);
            });

            reqUnmute.write(postDataUnmute);
            reqUnmute.end();

            gameServer.sendChatMessage(null, null, "🔊 " + targetPlayer._name + " has been unmuted");

            return { silent: true, message: "✓ Account unmuted (permanent)" };
        } else {
            // Mute
            var muteReason = split.slice(2).join(' ') || 'Muted by admin';

            var postDataMute = JSON.stringify({
                discordId: targetPlayer.discordId,
                reason: muteReason,
                hours: hours,
                adminDiscordId: player.discordId || null,
                gameServerKey: 'aetlis-gs-mod-2024-xK9mP2vL8nQ4'
            });

            var optionsMute = {
                hostname: 'aetlis.io',
                port: 443,
                path: '/api/game/mute',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postDataMute)
                }
            };

            var reqMute = https.request(optionsMute, function (res) {
                var body = '';
                res.on('data', function (chunk) { body += chunk; });
                res.on('end', function () {
                    if (res.statusCode === 200) {
                        Logger.info('[MUTE] ✅ Discord account mute SUCCESS!');
                        targetPlayer.isMuted = true;
                        targetPlayer.muteExpireTime = hours > 0 ? Date.now() + (hours * 60 * 60 * 1000) : null;
                    } else {
                        Logger.error('[MUTE] ❌ Discord account mute FAILED! Status:', res.statusCode, 'Response:', body);
                    }
                });
            });

            reqMute.on('error', function (err) {
                Logger.error('[MUTE] ❌ API request error:', err.message);
            });

            reqMute.write(postDataMute);
            reqMute.end();

            Logger.warn('[MUTE] 🔇 ACCOUNT MUTED:', targetPlayer.discordName, '(', targetPlayer.discordId, ') for', hours, 'hours');

            gameServer.sendChatMessage(null, null, "🔇 " + targetPlayer._name + " has been muted for " + hours + " hours (permanent)");

            return { silent: true, message: "✓ Account muted (permanent)\nDiscord: " + targetPlayer.discordName + "\nDuration: " + hours + "h\nReason: " + muteReason };
        }
    },

    // NOTIFY (send private message)
    notify: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.MODER) {
            return "ERROR: Access denied!";
        }

        var split = args.split(' ');
        if (split.length < 2) {
            return "Usage: /notify [PlayerID] [message]";
        }

        var targetPlayer = getPlayerById(gameServer, split[0]);
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        var message = split.slice(1).join(' ');
        gameServer.sendChatMessage(null, targetPlayer, "[ADMIN] " + message);

        Logger.info("ADMIN: " + player._name + " sent notify to " + targetPlayer.pID + ": " + message);
        return { silent: true, message: "✓ Message sent" };
    },

    // ADMINLIST - Show online admins
    adminlist: function (gameServer, player, args) {
        var admins = [];
        for (var i = 0; i < gameServer.clients.length; i++) {
            var client = gameServer.clients[i];
            if (client && client.playerTracker && client.playerTracker.userRole >= UserRoleEnum.MODER) {
                var role = client.playerTracker.userRole === UserRoleEnum.ADMIN ? "ADMIN" : "MODER";
                admins.push(client.playerTracker.pID + ": " + client.playerTracker._name + " [" + role + "]");
            }
        }

        if (admins.length === 0) {
            return "No admins online";
        }

        return "Online admins: " + admins.join(", ");
    },

    // SPAWN ENTITY
    spawnentity: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.ADMIN) {
            return "ERROR: Access denied!";
        }

        var split = args.split(' ');
        if (split.length < 3) {
            return "Usage: /spawnentity [type] [X] [Y] [size]";
        }

        var type = split[0].toLowerCase();
        var x = parseFloat(split[1]);
        var y = parseFloat(split[2]);
        var size = split[3] ? parseFloat(split[3]) : null;

        if (isNaN(x) || isNaN(y)) {
            return "ERROR: Invalid coordinates";
        }

        var pos = { x: x, y: y };
        var entity;

        switch (type) {
            case "virus":
                size = size || gameServer.config.virusMinSize;
                entity = new Entity.Virus(gameServer, null, pos, size);
                break;
            case "food":
                size = size || gameServer.config.foodMinSize;
                entity = new Entity.Food(gameServer, null, pos, size);
                entity.setColor(gameServer.getRandomColor());
                break;
            case "eject":
            case "ejected":
                size = size || gameServer.config.ejectSize;
                entity = new Entity.EjectedMass(gameServer, null, pos, size);
                entity.setColor(gameServer.getRandomColor());
                break;
            default:
                return "ERROR: Unknown entity type. Use: virus, food, eject";
        }

        if (entity) {
            gameServer.addNode(entity);
            Logger.info("ADMIN: " + player._name + " spawned " + type + " at (" + x + "," + y + ")");
            return { silent: true, message: "✓ " + type + " spawned" };
        }

        return "ERROR: Failed to spawn entity";
    },

    // GIVE REC (instant recombine)
    giverec: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.MODER) {
            return "ERROR: Access denied!";
        }

        var targetPlayer = getPlayerById(gameServer, args.trim());
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        targetPlayer.rec = !targetPlayer.rec;

        Logger.info("ADMIN: " + player._name + " " + (targetPlayer.rec ? "gave" : "removed") + " rec to player " + targetPlayer.pID);
        return { silent: true, message: "✓ Rec " + (targetPlayer.rec ? "enabled" : "disabled") };
    },

    // FORCE MERGE
    forcemerge: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.MODER) {
            return "ERROR: Access denied!";
        }

        var targetPlayer = getPlayerById(gameServer, args.trim());
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        targetPlayer.mergeOverride = true;

        Logger.info("ADMIN: " + player._name + " forced merge for player " + targetPlayer.pID);
        return { silent: true, message: "✓ Merge forced" };
    },

    // CHECK ACTIVE TOKENS (for debugging duplicate login protection)
    tokens: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.ADMIN) {
            return "ERROR: Access denied!";
        }

        var activeCount = gameServer.activeDiscordTokens.size;
        var message = "📊 Active Discord Tokens: " + activeCount;

        // If args is "list", show detailed list
        if (args && args.trim().toLowerCase() === 'list') {
            message += "\n";
            var count = 0;
            gameServer.activeDiscordTokens.forEach(function (socket, token) {
                count++;
                var playerName = socket.playerTracker ? socket.playerTracker._name : 'unknown';
                var playerId = socket.playerTracker ? socket.playerTracker.pID : '?';
                var connected = socket.isConnected ? '✓' : '✗';
                message += "\n" + count + ". [" + playerId + "] " + playerName + " " + connected + " " + token.substring(0, 12) + "...";
            });
        }

        Logger.info("ADMIN: " + player._name + " checked active tokens");
        return { silent: true, message: message };
    },

    // LIST ONLINE PLAYERS
    list: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.MODER) {
            return "ERROR: Access denied!";
        }

        var onlinePlayers = [];
        for (var i = 0; i < gameServer.clients.length; i++) {
            var client = gameServer.clients[i];
            if (client && client.playerTracker && client.isConnected) {
                var p = client.playerTracker;
                if (!p.isMinion) {
                    onlinePlayers.push({
                        id: p.pID,
                        name: p._name || 'Unnamed',
                        cells: p.cells.length,
                        hasToken: !!p.discordToken
                    });
                }
            }
        }

        if (onlinePlayers.length === 0) {
            return { silent: true, message: "📋 No players online" };
        }

        var message = "📋 Online Players (" + onlinePlayers.length + "):";
        for (var i = 0; i < onlinePlayers.length; i++) {
            var p = onlinePlayers[i];
            var tokenStatus = p.hasToken ? '🔑' : '🚫';
            message += "\n[" + p.id + "] " + p.name + " " + tokenStatus + " (" + p.cells + " cells)";
        }

        Logger.info("ADMIN: " + player._name + " listed online players");
        return { silent: true, message: message };
    },

    // BAN PLAYER BY ID (bans their Discord account + IP)
    ban: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.ADMIN) {
            return "ERROR: Access denied! Admin only.";
        }

        var split = args.trim().split(' ');
        if (split.length < 2) {
            return "Usage: /ban [PlayerID] [reason]";
        }

        var targetPlayerId = parseInt(split[0]);
        var reason = split.slice(1).join(' ');

        if (isNaN(targetPlayerId)) {
            return "ERROR: Invalid player ID";
        }

        // Find player
        var targetPlayer = getPlayerById(gameServer, targetPlayerId);
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        if (targetPlayer === player) {
            return "ERROR: Cannot ban yourself!";
        }

        // Get player IP for ban
        var playerIP = targetPlayer.socket.remoteAddress;
        var targetName = targetPlayer._name || 'Unnamed';
        var banType = "IP Only";

        // If player has Discord ID (logged in user), ban their account
        if (targetPlayer.discordId) {
            Logger.info('[BAN] 🔨 Banning Discord account via API...');
            Logger.info('[BAN] Discord ID:', targetPlayer.discordId);
            Logger.info('[BAN] Discord Name:', targetPlayer.discordName || 'N/A');

            var https = require('https');
            var postData = JSON.stringify({
                discordId: targetPlayer.discordId,
                reason: reason,
                adminDiscordId: player.discordId || null,
                gameServerKey: 'aetlis-gs-mod-2024-xK9mP2vL8nQ4'
            });

            var options = {
                hostname: 'aetlis.io',
                port: 443,
                path: '/api/game/ban',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            var req = https.request(options, function (res) {
                var body = '';
                res.on('data', function (chunk) { body += chunk; });
                res.on('end', function () {
                    if (res.statusCode === 200) {
                        Logger.info('[BAN] ✅ Discord account ban SUCCESS! Response:', body);
                    } else {
                        Logger.error('[BAN] ❌ Discord account ban FAILED! Status:', res.statusCode, 'Response:', body);
                    }
                });
            });

            req.on('error', function (err) {
                Logger.error('[BAN] ❌ API request error:', err.message);
            });

            req.write(postData);
            req.end();

            banType = "Discord Account + IP";
        } else if (targetPlayer.discordToken) {
            // Has token but no Discord ID (shouldn't happen after our fix, but fallback)
            Logger.warn('[BAN] ⚠️ Player has Discord token but no Discord ID - using token-based ban');

            var https2 = require('https');
            var postData2 = JSON.stringify({
                discordToken: targetPlayer.discordToken,
                reason: reason,
                adminDiscordId: player.discordId || null,
                gameServerKey: 'aetlis-gs-mod-2024-xK9mP2vL8nQ4'
            });

            var options2 = {
                hostname: 'aetlis.io',
                port: 443,
                path: '/api/game/ban',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData2)
                }
            };

            var req2 = https2.request(options2, function (res) {
                var body = '';
                res.on('data', function (chunk) { body += chunk; });
                res.on('end', function () {
                    if (res.statusCode === 200) {
                        Logger.info('[BAN] ✅ Token-based account ban SUCCESS!');
                    } else {
                        Logger.error('[BAN] ❌ Token-based account ban FAILED! Status:', res.statusCode, 'Response:', body);
                    }
                });
            });

            req2.on('error', function (err) {
                Logger.error('[BAN] ❌ API request error:', err.message);
            });

            req2.write(postData2);
            req2.end();

            banType = "Discord Token + IP";
        } else {
            // No Discord account - will only IP ban
            Logger.warn('[BAN] ⚠️ Player not logged in - only IP ban will be applied');
        }

        // Always ban the IP address (dual ban system)
        if (playerIP && !gameServer.ipBanList.includes(playerIP)) {
            gameServer.ipBanList.push(playerIP);
            Logger.warn('[BAN] 📋 IP added to ban list:', playerIP);

            // Save IP ban list to file
            var fs = require('fs');
            try {
                var banListPath = './src/ipbanlist.txt';
                fs.writeFileSync(banListPath, gameServer.ipBanList.join('\n'), 'utf8');
                Logger.info('[BAN] ✅ IP ban list saved (' + gameServer.ipBanList.length + ' entries)');
            } catch (err) {
                Logger.error('[BAN] ❌ Failed to save IP ban list:', err.message);
            }
        }

        // Kick the player immediately
        targetPlayer.socket.close(1008, 'Banned: ' + reason);

        Logger.warn('[BAN] 🔨 PLAYER BANNED:');
        Logger.warn('[BAN]   Admin:', player._name, '(ID:', player.pID + ')');
        Logger.warn('[BAN]   Target:', targetName, '(ID:', targetPlayerId + ')');
        Logger.warn('[BAN]   Discord ID:', targetPlayer.discordId || 'N/A');
        Logger.warn('[BAN]   IP:', playerIP);
        Logger.warn('[BAN]   Type:', banType);
        Logger.warn('[BAN]   Reason:', reason);

        // Broadcast to all players
        gameServer.sendChatMessage(null, null, "🔨 " + targetName + " has been BANNED by admin!");

        return {
            silent: true,
            message: "✓ PLAYER BANNED!\n" +
                "━━━━━━━━━━━━━━━━━━━━\n" +
                "Name: " + targetName + "\n" +
                "ID: " + targetPlayerId + "\n" +
                "Discord ID: " + (targetPlayer.discordId || 'Not logged in') + "\n" +
                "IP: " + playerIP + "\n" +
                "Ban Type: " + banType + "\n" +
                "Reason: " + reason + "\n" +
                "━━━━━━━━━━━━━━━━━━━━"
        };
    },

    // UNBAN by Discord token (admin must provide token prefix)
    unban: function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.ADMIN) {
            return "ERROR: Access denied! Admin only.";
        }

        var tokenPrefix = args.trim();
        if (tokenPrefix.length < 10) {
            return "Usage: /unban [tokenPrefix]\nExample: /unban abc1234567...";
        }

        // Unban via API
        var https = require('https');
        var postData = JSON.stringify({
            tokenPrefix: tokenPrefix,
            adminId: player.userAuth || 'In-game Admin'
        });

        var options = {
            hostname: 'aetlis.io',
            port: 443,
            path: '/api/unban',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        var req = https.request(options, function (res) {
            var body = '';
            res.on('data', function (chunk) { body += chunk; });
            res.on('end', function () {
                Logger.info("UNBAN API Response: " + body);
            });
        });

        req.on('error', function (err) {
            Logger.error("UNBAN API Error: " + err.message);
        });

        req.write(postData);
        req.end();

        Logger.info("ADMIN UNBAN: " + player._name + " unbanned token: " + tokenPrefix);

        return { silent: true, message: "✓ Unban request sent to API for token: " + tokenPrefix };
    },
    'start-tournament': function (gameServer, player, args) {
        return startTournamentCommand(gameServer, player, args, false);
    },
    'start-tournament-now': function (gameServer, player) {
        return startTournamentCommand(gameServer, player, null, true);
    },
    'tournament-start-now': function (gameServer, player) {
        return startTournamentCommand(gameServer, player, null, true);
    },
    'tournament-start': function (gameServer, player, args) {
        return startTournamentCommand(gameServer, player, args, false);
    },

    // LUKA AI API KEY MANAGEMENT
    'luka-api': async function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.ADMIN) {
            return "ERROR: Access denied! Admin only.";
        }

        var LukaAI = require('./LukaAI');

        // If no args, show current status and test connection
        if (!args || args.trim().length === 0) {
            var currentKey = LukaAI.getApiKeyMasked();
            var testResult = await LukaAI.testApi();

            if (testResult.success) {
                return {
                    silent: true,
                    message: "🤖 Luka AI Status:\n" +
                        "━━━━━━━━━━━━━━━━━━━━\n" +
                        "API Key: " + currentKey + "\n" +
                        "Connection: ✅ OK\n" +
                        "Queue: " + LukaAI.getQueueLength() + " messages\n" +
                        "━━━━━━━━━━━━━━━━━━━━\n" +
                        "Usage: /luka-api [new_api_key]"
                };
            } else {
                return {
                    silent: true,
                    message: "🤖 Luka AI Status:\n" +
                        "━━━━━━━━━━━━━━━━━━━━\n" +
                        "API Key: " + currentKey + "\n" +
                        "Connection: ❌ FAILED\n" +
                        "Error: " + testResult.message + "\n" +
                        "━━━━━━━━━━━━━━━━━━━━\n" +
                        "Usage: /luka-api [new_api_key]"
                };
            }
        }

        // New API key provided - update it
        var newApiKey = args.trim();
        Logger.info('[LUKA-API] Admin ' + player._name + ' is updating API key...');

        var result = await LukaAI.setApiKey(newApiKey);

        if (result.success) {
            Logger.info('[LUKA-API] ✅ API key updated successfully by ' + player._name);
            return {
                silent: true,
                message: "🤖 Luka AI:\n" +
                    "━━━━━━━━━━━━━━━━━━━━\n" +
                    "✅ " + result.message + "\n" +
                    "New Key: " + LukaAI.getApiKeyMasked() + "\n" +
                    "━━━━━━━━━━━━━━━━━━━━"
            };
        } else {
            Logger.warn('[LUKA-API] ❌ API key update failed: ' + result.message);
            return {
                silent: true,
                message: "🤖 Luka AI:\n" +
                    "━━━━━━━━━━━━━━━━━━━━\n" +
                    "❌ " + result.message + "\n" +
                    "Key unchanged: " + LukaAI.getApiKeyMasked() + "\n" +
                    "━━━━━━━━━━━━━━━━━━━━"
            };
        }
    },

    'cancel-tournament': function (gameServer, player) {
        if (player.userRole < UserRoleEnum.ADMIN) {
            return "ERROR: Access denied!";
        }
        if (!gameServer.tournamentManager) {
            return "ERROR: Tournament system unavailable.";
        }

        if (gameServer.tournamentManager.cancel()) {
            return "✓ Tournament cancelled";
        }
        return "ERROR: No active tournament";
    },

    // COLLISION LOGGING - Debug collision mechanics
    'log-colli': function (gameServer, player, args) {
        if (player.userRole < UserRoleEnum.MODER) {
            return "ERROR: Access denied!";
        }

        var playerId = parseInt(args.trim());
        if (isNaN(playerId)) {
            // Show currently logged players
            var logged = Array.from(gameServer.collisionLogPlayerIds);
            if (logged.length === 0) {
                return "No players being logged.\nUsage: /log-colli <playerid>";
            }
            return "Logging collision for: " + logged.join(", ");
        }

        var targetPlayer = getPlayerById(gameServer, playerId);
        if (!targetPlayer) {
            return "ERROR: Player not found";
        }

        if (gameServer.collisionLogPlayerIds.has(playerId)) {
            gameServer.collisionLogPlayerIds.delete(playerId);
            Logger.info('[COLLI-LOG] Disabled collision logging for player ' + playerId);
            return { silent: true, message: "✓ Collision logging DISABLED for player " + playerId + " (" + targetPlayer._name + ")" };
        } else {
            gameServer.collisionLogPlayerIds.add(playerId);
            Logger.info('[COLLI-LOG] Enabled collision logging for player ' + playerId);
            return { silent: true, message: "✓ Collision logging ENABLED for player " + playerId + " (" + targetPlayer._name + ")\nCheck server terminal for logs." };
        }
    }
};

// Export individual command functions
AdminCommands.processCommand = function (gameServer, player, commandName, args) {
    commandName = commandName.toLowerCase();

    if (!AdminCommands.list.hasOwnProperty(commandName)) {
        return null; // Command not found
    }

    try {
        return AdminCommands.list[commandName](gameServer, player, args);
    } catch (err) {
        Logger.error("Admin command error: " + err.message);
        return "ERROR: Command failed - " + err.message;
    }
};
