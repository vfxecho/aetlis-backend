var Logger = require('./Logger');
var UserRoleEnum = require("../enum/UserRoleEnum");
var Entity = require('../entity');

var ErrorTextInvalidCommand = "ERROR: Unknown command, type /id for your ID";
var ErrorTextBadCommand = "ERROR: Bad command!";
var ErrorTextNoPermission = "❌ Access denied!";

// Admin Discord IDs - hardcoded for security
var FULL_ADMIN_DISCORD_ID = '707227552627949639';  // Full admin access

function PlayerCommand(gameServer, playerTracker) {
    this.gameServer = gameServer;
    this.playerTracker = playerTracker;
}

module.exports = PlayerCommand;

PlayerCommand.prototype.writeLine = function (text) {
    this.gameServer.sendChatMessage(null, this.playerTracker, text);
};

// Check if player has full admin permissions (level 2)
PlayerCommand.prototype.isFullAdmin = function () {
    var player = this.playerTracker;

    // Check hardcoded Discord ID first
    if (player.discordId === FULL_ADMIN_DISCORD_ID) {
        return true;
    }

    // Check legacy userRole
    if (player.userRole >= UserRoleEnum.ADMIN) {
        return true;
    }

    // Check admin level from API
    return player.adminLevel >= 2;
};

// Check if player has moderator permissions (level 1+)
PlayerCommand.prototype.isModerator = function () {
    var player = this.playerTracker;

    // Full admin is also moderator
    if (this.isFullAdmin()) return true;

    // Check legacy userRole
    if (player.userRole >= UserRoleEnum.MODER) {
        return true;
    }

    // Check admin level from API (mod is level 1)
    return player.adminLevel >= 1;
};

PlayerCommand.prototype.executeCommandLine = function (commandLine) {
    if (!commandLine) return;
    var command = commandLine;
    var args = "";
    var index = commandLine.indexOf(' ');
    if (index >= 0) {
        command = commandLine.slice(0, index);
        args = commandLine.slice(index + 1, commandLine.length);
    }
    command = command.trim().toLowerCase();
    if (command.length > 24) {
        this.writeLine(ErrorTextInvalidCommand);
        return;
    }
    for (var i = 0; i < command.length; i++) {
        var c = command.charCodeAt(i);
        if (c < 0x21 || c > 0x7F) {
            this.writeLine(ErrorTextInvalidCommand);
            return;
        }
    }
    if (!playerCommands.hasOwnProperty(command)) {
        this.writeLine(ErrorTextInvalidCommand);
        return;
    }
    var execute = playerCommands[command];
    if (typeof execute == 'function') {
        execute.bind(this)(args);

        // =====================================
        // MODERATION LOGGING
        // Log admin/mod commands to API
        // =====================================
        var LOGGED_COMMANDS = [
            'tp', 'teleport', 'tphere', 'virus', 'mute', 'unmute',
            'ban', 'kick', 'mass', 'merge', 'freeze', 'killall',
            'food', 'virusall', 'troll', 'log-colli'
        ];

        if (LOGGED_COMMANDS.indexOf(command) >= 0 && (this.isModerator() || this.isFullAdmin())) {
            this._logModerationAction(command, args);
        }
    } else {
        this.writeLine(ErrorTextBadCommand);
    }
};

// Log moderation action to API
PlayerCommand.prototype._logModerationAction = function (command, args) {
    var player = this.playerTracker;
    if (!player.discordId) return; // No Discord = no log

    // Try to find target player from args
    var targetId = null;
    var targetName = null;
    if (args) {
        var targetArg = args.split(' ')[0];
        var target = this.findPlayer(targetArg);
        if (target) {
            targetId = target.discordId || target.pID.toString();
            targetName = target._name || 'Unnamed';
        }
    }

    var postData = JSON.stringify({
        adminDiscordId: player.discordId,
        adminName: player._name || player.discordName || 'Unknown',
        command: command,
        args: args || '',
        targetId: targetId,
        targetName: targetName,
        ipAddress: player.socket ? player.socket.remoteAddress : null
    });

    var https = require('https');
    var options = {
        hostname: 'aetlis.io',
        port: 443,
        path: '/api/game/moderation-log',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    var req = https.request(options, function (res) {
        // Silent - no need to handle response
    });
    req.on('error', function (e) {
        Logger.debug('[MOD-LOG] API error: ' + e.message);
    });
    req.write(postData);
    req.end();
};

PlayerCommand.prototype.userLogin = function (ip, password) {
    if (!password) return null;
    password = password.trim();
    if (!password) return null;
    for (var i = 0; i < this.gameServer.userList.length; i++) {
        var user = this.gameServer.userList[i];
        if (user.password != password)
            continue;
        if (user.ip && user.ip != ip)
            continue;
        return user;
    }
    return null;
};

// Find player by ID
PlayerCommand.prototype.findPlayerById = function (id) {
    var pID = parseInt(id);
    if (isNaN(pID)) return null;

    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;
        if (client.playerTracker.pID === pID) {
            return client.playerTracker;
        }
    }
    return null;
};

// Find player by name (partial match)
PlayerCommand.prototype.findPlayerByName = function (name) {
    if (!name) return null;
    name = name.toLowerCase().trim();

    var clients = this.gameServer.clients;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client || !client.playerTracker) continue;

        var playerName = (client.playerTracker._name || '').toLowerCase();
        if (playerName === name || playerName.indexOf(name) >= 0) {
            return client.playerTracker;
        }
    }
    return null;
};

// Find player - try ID first, then name
PlayerCommand.prototype.findPlayer = function (arg) {
    if (!arg) return null;
    arg = arg.trim();

    // Try as ID first
    var byId = this.findPlayerById(arg);
    if (byId) return byId;

    // Try as name
    return this.findPlayerByName(arg);
};

var playerCommands = {
    // =====================================
    // BASIC COMMANDS - Everyone can use
    // =====================================

    id: function (args) {
        this.writeLine("Your ID: " + this.playerTracker.pID);
    },

    skin: function (args) {
        if (this.playerTracker.cells.length > 0) {
            this.writeLine("ERROR: Cannot change skin while playing!");
            return;
        }
        var skinName = "";
        if (args) skinName = args.trim();
        this.playerTracker.setSkin(skinName);
        if (skinName == "")
            this.writeLine("Skin removed");
        else
            this.writeLine("Skin: " + skinName);
    },

    kill: function (args) {
        // Check if it's admin killing another player
        if (args && args.trim().length > 0 && this.isFullAdmin()) {
            var target = this.findPlayer(args);
            if (!target) {
                this.writeLine("❌ Player not found: " + args);
                return;
            }

            // Kill target player
            while (target.cells.length > 0) {
                this.gameServer.removeNode(target.cells[0]);
            }
            Logger.info('[ADMIN-KILL] ' + this.playerTracker._name + ' killed ' + target._name);
            return;
        }

        // Self kill
        if (this.playerTracker.cells.length < 1) {
            this.writeLine("You're not in game!");
            return;
        }
        while (this.playerTracker.cells.length > 0) {
            var cell = this.playerTracker.cells[0];
            this.gameServer.removeNode(cell);
        }
        this.writeLine("You killed yourself");
    },

    // =====================================
    // MODERATOR COMMANDS - Level 1+
    // =====================================

    mute: function (args) {
        if (!this.isModerator()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var split = args.split(' ');
        var targetArg = split[0];
        var duration = parseInt(split[1]) || 0; // Duration in minutes, 0 = permanent

        if (!targetArg) {
            this.writeLine("Usage: /mute <id> [minutes]");
            return;
        }

        var target = this.findPlayer(targetArg);
        if (!target) {
            this.writeLine("❌ Player not found");
            return;
        }

        // Don't allow muting higher level admins
        if (target.adminLevel >= this.playerTracker.adminLevel && target !== this.playerTracker) {
            this.writeLine("❌ Cannot mute this player!");
            return;
        }

        // Set local mute immediately
        target.isMuted = true;

        // Send API request to persist mute
        if (target.discordToken && this.playerTracker.discordToken) {
            var https = require('https');
            var postData = JSON.stringify({
                targetToken: target.discordToken,
                reason: 'Muted by moderator',
                adminToken: this.playerTracker.discordToken,
                duration: duration
            });

            var options = {
                hostname: 'aetlis.io',
                port: 443,
                path: '/api/mute',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            var req = https.request(options, function (res) { });
            req.on('error', function (e) {
                Logger.debug('[MUTE] API error: ' + e.message);
            });
            req.write(postData);
            req.end();
        }

        var durationText = duration > 0 ? ' (' + duration + 'm)' : '';
        this.gameServer.sendChatMessage(null, null, "🔇 " + (target._name || "unnamed") + " muted" + durationText);
        Logger.info('[MUTE] ' + this.playerTracker._name + ' muted ' + target._name);
    },

    unmute: function (args) {
        if (!this.isModerator()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        if (!args || !args.trim()) {
            this.writeLine("Usage: /unmute <id>");
            return;
        }

        var target = this.findPlayer(args);
        if (!target) {
            this.writeLine("❌ Player not found");
            return;
        }

        target.isMuted = false;

        // Send API request to remove mute
        if (target.discordToken && this.playerTracker.discordToken) {
            var https = require('https');
            var postData = JSON.stringify({
                targetToken: target.discordToken,
                adminToken: this.playerTracker.discordToken
            });

            var options = {
                hostname: 'aetlis.io',
                port: 443,
                path: '/api/unmute',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            var req = https.request(options, function (res) { });
            req.on('error', function (e) {
                Logger.debug('[UNMUTE] API error: ' + e.message);
            });
            req.write(postData);
            req.end();
        }

        this.gameServer.sendChatMessage(null, null, "🔊 " + (target._name || "unnamed") + " unmuted");
        Logger.info('[UNMUTE] ' + this.playerTracker._name + ' unmuted ' + target._name);
    },

    tp: function (args) {
        // Teleporter role can only use /tp in tournament servers
        var isTournamentMode = this.gameServer.tournamentManager && this.gameServer.tournamentManager.isActive;
        var isTeleporter = this.playerTracker.isTeleporter;

        // Teleporter in non-tournament = access denied
        if (isTeleporter && !isTournamentMode && !this.isModerator()) {
            this.writeLine("Teleporter role only works in tournament servers!");
            return;
        }

        // Allow if: Moderator+, or Teleporter in tournament mode
        var hasAccess = this.isModerator() || (isTeleporter && isTournamentMode);

        if (!hasAccess) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var split = args.split(' ');

        // /tp <id> - teleport self to player
        if (split.length === 1 && split[0]) {
            var target = this.findPlayer(split[0]);
            if (!target) {
                this.writeLine("Player not found");
                return;
            }

            if (target.cells.length === 0) {
                this.writeLine("Target has no cells!");
                return;
            }

            if (this.playerTracker.cells.length === 0) {
                this.writeLine("You have no cells!");
                return;
            }

            var targetPos = target.centerPos;
            for (var i = 0; i < this.playerTracker.cells.length; i++) {
                var cell = this.playerTracker.cells[i];
                cell.position.x = targetPos.x;
                cell.position.y = targetPos.y;
                this.gameServer.updateNodeQuad(cell);
            }

            Logger.info('[TP] ' + this.playerTracker._name + ' teleported to ' + target._name);
            return;
        }

        // /tp <id> <x> <y> - teleport player to coordinates
        if (split.length >= 3) {
            var target = this.findPlayer(split[0]);
            if (!target) {
                this.writeLine("Player not found");
                return;
            }

            var x = parseFloat(split[1]);
            var y = parseFloat(split[2]);

            if (isNaN(x) || isNaN(y)) {
                this.writeLine("Invalid coordinates");
                return;
            }

            if (target.cells.length === 0) {
                this.writeLine("Target has no cells!");
                return;
            }

            // Calculate total mass
            var totalMass = 0;
            for (var i = 0; i < target.cells.length; i++) {
                totalMass += target.cells[i]._mass;
            }

            // Remove all cells except first
            while (target.cells.length > 1) {
                this.gameServer.removeNode(target.cells[target.cells.length - 1]);
            }

            // Teleport remaining cell
            if (target.cells.length > 0) {
                var cell = target.cells[0];
                cell.position.x = x;
                cell.position.y = y;
                var newSize = Math.sqrt(totalMass * 100);
                cell.setSize(newSize);
                this.gameServer.updateNodeQuad(cell);
            }

            Logger.info('[TP] ' + this.playerTracker._name + ' teleported ' + target._name + ' to (' + x + ',' + y + ')');
            return;
        }

        this.writeLine("Usage: /tp <id> OR /tp <id> <x> <y>");
    },

    // Alias for tp
    teleport: function (args) {
        return playerCommands.tp.bind(this)(args);
    },

    tphere: function (args) {
        // Teleporter role can only use /tphere in tournament servers
        var isTournamentMode = this.gameServer.tournamentManager && this.gameServer.tournamentManager.isActive;
        var isTeleporter = this.playerTracker.isTeleporter;

        if (isTeleporter && !isTournamentMode && !this.isModerator()) {
            this.writeLine("Teleporter role only works in tournament servers!");
            return;
        }

        var hasAccess = this.isModerator() || (isTeleporter && isTournamentMode);

        if (!hasAccess) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        if (!args || !args.trim()) {
            this.writeLine("Usage: /tphere <id>");
            return;
        }

        var target = this.findPlayer(args);
        if (!target) {
            this.writeLine("Player not found");
            return;
        }

        if (this.playerTracker.cells.length === 0) {
            this.writeLine("You have no cells!");
            return;
        }

        if (target.cells.length === 0) {
            this.writeLine("Target has no cells!");
            return;
        }

        var myPos = this.playerTracker.centerPos;
        for (var i = 0; i < target.cells.length; i++) {
            var cell = target.cells[i];
            cell.position.x = myPos.x;
            cell.position.y = myPos.y;
            this.gameServer.updateNodeQuad(cell);
        }

        Logger.info('[TP] ' + this.playerTracker._name + ' pulled ' + target._name);
    },

    virus: function (args) {
        if (!this.isModerator()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var split = args.split(' ');

        // /virus <id> - spawn virus on player
        if (split.length === 1 && split[0]) {
            var target = this.findPlayer(split[0]);
            if (!target) {
                this.writeLine("❌ Player not found");
                return;
            }

            if (target.cells.length === 0) {
                this.writeLine("❌ Target has no cells!");
                return;
            }

            var pos = target.centerPos;
            var virus = new Entity.Virus(this.gameServer, null, { x: pos.x, y: pos.y }, this.gameServer.config.virusMinSize);
            this.gameServer.addNode(virus);

            Logger.info('[VIRUS] ' + this.playerTracker._name + ' spawned virus on ' + target._name);
            return;
        }

        // /virus <x> <y> - spawn virus at coordinates
        if (split.length >= 2) {
            var x = parseFloat(split[0]);
            var y = parseFloat(split[1]);

            if (isNaN(x) || isNaN(y)) {
                this.writeLine("❌ Invalid coordinates");
                return;
            }

            var virus = new Entity.Virus(this.gameServer, null, { x: x, y: y }, this.gameServer.config.virusMinSize);
            this.gameServer.addNode(virus);

            Logger.info('[VIRUS] ' + this.playerTracker._name + ' spawned virus at (' + x + ',' + y + ')');
            return;
        }

        this.writeLine("Usage: /virus <id> OR /virus <x> <y>");
    },

    // =====================================
    // ADMIN COMMANDS - Level 2 (Full Admin)
    // =====================================

    ban: function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var split = args.trim().split(' ');
        var targetArg = split[0];
        var reason = split.slice(1).join(' ') || 'Banned by admin';

        if (!targetArg) {
            this.writeLine("Usage: /ban <id> [reason]");
            return;
        }

        var target = this.findPlayer(targetArg);
        if (!target) {
            this.writeLine("❌ Player not found");
            return;
        }

        if (target === this.playerTracker) {
            this.writeLine("❌ Cannot ban yourself!");
            return;
        }

        var targetName = target._name || 'Unnamed';
        var targetIP = target.socket ? target.socket.remoteAddress : null;
        var banType = "IP Only";
        var self = this;

        // Ban via API if player has Discord
        if (target.discordId) {
            var https = require('https');
            var postData = JSON.stringify({
                discordId: target.discordId,
                reason: reason,
                adminDiscordId: this.playerTracker.discordId || null,
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
                        Logger.info('[BAN] ✅ Discord account banned via API');
                    } else {
                        Logger.error('[BAN] ❌ API ban failed: ' + res.statusCode + ' ' + body);
                    }
                });
            });
            req.on('error', function (e) {
                Logger.error('[BAN] API error: ' + e.message);
            });
            req.write(postData);
            req.end();

            banType = "Discord + IP";
        } else if (target.discordToken) {
            // Token-based ban
            var https = require('https');
            var postData = JSON.stringify({
                token: target.discordToken,
                reason: reason,
                adminToken: this.playerTracker.discordToken
            });

            var options = {
                hostname: 'aetlis.io',
                port: 443,
                path: '/api/ban',
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
                        Logger.info('[BAN] ✅ Token-based ban success');
                    } else {
                        Logger.error('[BAN] ❌ Token ban failed: ' + res.statusCode);
                    }
                });
            });
            req.on('error', function (e) {
                Logger.error('[BAN] API error: ' + e.message);
            });
            req.write(postData);
            req.end();

            banType = "Token + IP";
        }

        // IP ban
        if (targetIP && this.gameServer.ipBanList && !this.gameServer.ipBanList.includes(targetIP)) {
            this.gameServer.ipBanList.push(targetIP);
            Logger.info('[BAN] IP banned: ' + targetIP);
        }

        // Broadcast and kick IMMEDIATELY
        this.gameServer.sendChatMessage(null, null, "🔨 " + targetName + " BANNED: " + reason);

        // Kick immediately - no delay
        if (target.socket && target.socket.close) {
            target.socket.close(1008, 'Banned: ' + reason);
        }

        Logger.warn('[BAN] ' + this.playerTracker._name + ' banned ' + targetName + ' (' + banType + ') - ' + reason);
        this.writeLine("🔨 Banned: " + targetName + " [" + banType + "]");
    },

    kick: function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        if (!args || !args.trim()) {
            this.writeLine("Usage: /kick <id>");
            return;
        }

        var target = this.findPlayer(args);
        if (!target) {
            this.writeLine("❌ Player not found");
            return;
        }

        if (target === this.playerTracker) {
            this.writeLine("❌ Cannot kick yourself!");
            return;
        }

        var targetName = target._name || 'Unnamed';

        // Broadcast and kick IMMEDIATELY
        this.gameServer.sendChatMessage(null, null, " " + targetName + " kicked");

        // Kick immediately - no delay
        if (target.socket && target.socket.close) {
            target.socket.close(1000, "Kicked by admin");
        }

        Logger.info('[KICK] ' + this.playerTracker._name + ' kicked ' + targetName);
        this.writeLine("Kicked: " + targetName);
    },

    mass: function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var split = args.split(' ');
        if (split.length < 2) {
            this.writeLine("Usage: /mass <id> <amount>");
            return;
        }

        var target = this.findPlayer(split[0]);
        if (!target) {
            this.writeLine("❌ Player not found");
            return;
        }

        if (target.cells.length === 0) {
            this.writeLine("❌ Target has no cells!");
            return;
        }

        var massValue = split[1];
        var isRelative = massValue[0] === '+' || massValue[0] === '-';
        var massChange = parseFloat(massValue);

        if (isNaN(massChange)) {
            this.writeLine("❌ Invalid mass value");
            return;
        }

        // Apply mass to all cells
        for (var i = 0; i < target.cells.length; i++) {
            var cell = target.cells[i];
            var currentMass = cell._mass;
            var newMass;

            if (isRelative) {
                newMass = Math.max(10, currentMass + massChange);
            } else {
                newMass = Math.max(10, massChange);
            }

            var newSize = Math.sqrt(newMass * 100);
            cell.setSize(newSize);
        }

        Logger.info('[MASS] ' + this.playerTracker._name + ' set mass of ' + target._name + ' to ' + massChange);
    },

    merge: function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        if (!args || !args.trim()) {
            this.writeLine("Usage: /merge <id>");
            return;
        }

        var target = this.findPlayer(args);
        if (!target) {
            this.writeLine("❌ Player not found");
            return;
        }

        target.mergeOverride = !target.mergeOverride;

        Logger.info('[MERGE] ' + this.playerTracker._name + ' toggled merge for ' + target._name);
    },

    freeze: function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        if (!args || !args.trim()) {
            this.writeLine("Usage: /freeze <id>");
            return;
        }

        var target = this.findPlayer(args);
        if (!target) {
            this.writeLine("❌ Player not found");
            return;
        }

        target.frozen = !target.frozen;

        var status = target.frozen ? "frozen" : "unfrozen";
        Logger.info('[FREEZE] ' + this.playerTracker._name + ' ' + status + ' ' + target._name);
    },

    killall: function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var killed = 0;
        var clients = this.gameServer.clients;

        for (var i = 0; i < clients.length; i++) {
            var client = clients[i];
            if (!client || !client.playerTracker) continue;
            if (client.playerTracker === this.playerTracker) continue;

            var target = client.playerTracker;
            while (target.cells.length > 0) {
                this.gameServer.removeNode(target.cells[0]);
            }
            killed++;
        }

        Logger.info('[KILLALL] ' + this.playerTracker._name + ' killed all (' + killed + ')');
    },

    food: function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var amount = parseInt(args) || 100;
        if (amount > 1000) amount = 1000;

        for (var i = 0; i < amount; i++) {
            var pos = this.gameServer.getRandomPosition();
            var food = new Entity.Food(this.gameServer, null, pos, this.gameServer.config.foodMinSize);
            food.setColor(this.gameServer.getRandomColor());
            this.gameServer.addNode(food);
        }

        Logger.info('[FOOD] ' + this.playerTracker._name + ' spawned ' + amount + ' food');
    },

    virusall: function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var count = 0;
        var clients = this.gameServer.clients;

        for (var i = 0; i < clients.length; i++) {
            var client = clients[i];
            if (!client || !client.playerTracker) continue;
            if (client.playerTracker === this.playerTracker) continue;
            if (client.playerTracker.cells.length === 0) continue;

            var pos = client.playerTracker.centerPos;
            var virus = new Entity.Virus(this.gameServer, null, { x: pos.x, y: pos.y }, this.gameServer.config.virusMinSize);
            this.gameServer.addNode(virus);
            count++;
        }

        Logger.info('[VIRUSALL] ' + this.playerTracker._name + ' virused all (' + count + ')');
    },

    // Troll overlay
    troll: function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var split = args.trim().split(/\s+/);
        if (split.length < 1 || !split[0]) {
            this.writeLine("Usage: /troll <id> [imageUrl] [audioUrl] [durationMs]");
            return;
        }

        var target = this.findPlayer(split[0]);
        if (!target) {
            this.writeLine("❌ Player not found");
            return;
        }

        var DEFAULT_TROLL_IMAGE = 'https://cdn.neoldu.com.tr/news/63518.jpg';
        var DEFAULT_TROLL_DURATION = 4000;

        var imageUrl = split.length > 1 ? split[1] : DEFAULT_TROLL_IMAGE;
        var audioUrl = split.length > 2 ? split[2] : "";
        var durationMs = split.length > 3 ? parseInt(split[3], 10) : DEFAULT_TROLL_DURATION;

        // Clamp duration
        if (isNaN(durationMs) || durationMs < 500) durationMs = 500;
        if (durationMs > 20000) durationMs = 20000;

        var payloadObject = {
            image: imageUrl,
            audio: audioUrl,
            duration: durationMs
        };

        var encodedPayload;
        try {
            encodedPayload = Buffer.from(JSON.stringify(payloadObject), 'utf8').toString('base64');
        } catch (err) {
            this.writeLine("❌ Failed to encode troll payload");
            return;
        }

        var fullPayload = "TROLL|" + encodedPayload;
        this.gameServer.sendChatMessage(null, target, fullPayload);

        Logger.info('[TROLL] ' + this.playerTracker._name + ' trolled ' + target._name);
    },

    // Player list
    list: function (args) {
        if (!this.isModerator()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var players = [];
        var clients = this.gameServer.clients;

        for (var i = 0; i < clients.length; i++) {
            var client = clients[i];
            if (!client || !client.playerTracker || !client.isConnected) continue;
            if (client.playerTracker.isMinion) continue;

            var p = client.playerTracker;
            players.push("[" + p.pID + "] " + (p._name || "unnamed"));
        }

        // Send list privately to admin only
        for (var j = 0; j < players.length; j++) {
            this.writeLine(players[j]);
        }
    },

    // Collision debug logging
    'log-colli': function (args) {
        if (!this.isModerator()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var playerId = parseInt(args.trim());
        if (isNaN(playerId)) {
            // Show currently logged players
            var logged = Array.from(this.gameServer.collisionLogPlayerIds);
            if (logged.length === 0) {
                this.writeLine("No players being logged.");
                this.writeLine("Usage: /log-colli <playerid>");
                return;
            }
            this.writeLine("Logging collision for: " + logged.join(", "));
            return;
        }

        var target = this.findPlayerById(playerId);
        if (!target) {
            this.writeLine("❌ Player not found");
            return;
        }

        if (this.gameServer.collisionLogPlayerIds.has(playerId)) {
            this.gameServer.collisionLogPlayerIds.delete(playerId);
            Logger.info('[COLLI-LOG] Disabled for player ' + playerId);
            this.writeLine("✓ Collision logging DISABLED for " + playerId + " (" + target._name + ")");
        } else {
            this.gameServer.collisionLogPlayerIds.add(playerId);
            Logger.info('[COLLI-LOG] Enabled for player ' + playerId);
            this.writeLine("✓ Collision logging ENABLED for " + playerId + " (" + target._name + ")");
            this.writeLine("Check server terminal for logs.");
        }
    },

    // =====================================
    // LEGACY COMMANDS
    // =====================================

    login: function (args) {
        var password = (args || "").trim();
        if (password.length < 1) {
            this.writeLine("ERROR: missing password!");
            return;
        }
        var user = this.userLogin(this.playerTracker.socket.remoteAddress, password);
        if (!user) {
            this.writeLine("ERROR: login failed!");
            return;
        }
        Logger.write("LOGIN " + this.playerTracker.socket.remoteAddress + " as " + user.name);
        this.playerTracker.userRole = user.role;
        this.playerTracker.userAuth = user.name;
        this.writeLine("Logged in as " + user.name);
    },

    logout: function (args) {
        if (this.playerTracker.userRole == UserRoleEnum.GUEST) {
            this.writeLine("ERROR: not logged in");
            return;
        }
        Logger.write("LOGOUT " + this.playerTracker.socket.remoteAddress);
        this.playerTracker.userRole = UserRoleEnum.GUEST;
        this.playerTracker.userAuth = null;
        this.writeLine("Logged out");
    },

    // Luka AI API key management
    'luka-api': async function (args) {
        if (!this.isFullAdmin()) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }

        var LukaAI = require('./LukaAI');
        var self = this;

        // If no args, show current status
        if (!args || args.trim().length === 0) {
            var currentKey = LukaAI.getApiKeyMasked();
            this.writeLine("🤖 Luka AI - Testing connection...");

            try {
                var testResult = await LukaAI.testApi();

                if (testResult.success) {
                    self.writeLine("━━━━━━━━━━━━━━━━━━━━");
                    self.writeLine("API Key: " + currentKey);
                    self.writeLine("Connection: ✅ OK");
                    self.writeLine("Queue: " + LukaAI.getQueueLength() + " pending");
                    self.writeLine("━━━━━━━━━━━━━━━━━━━━");
                    self.writeLine("Use: /luka-api [new_key]");
                } else {
                    self.writeLine("━━━━━━━━━━━━━━━━━━━━");
                    self.writeLine("API Key: " + currentKey);
                    self.writeLine("Connection: ❌ FAILED");
                    self.writeLine("Error: " + testResult.message);
                    self.writeLine("━━━━━━━━━━━━━━━━━━━━");
                    self.writeLine("Use: /luka-api [new_key]");
                }
            } catch (err) {
                self.writeLine("❌ Test error: " + err.message);
            }
            return;
        }

        // New API key provided
        var newApiKey = args.trim();
        this.writeLine("🤖 Updating API key...");

        try {
            var result = await LukaAI.setApiKey(newApiKey);

            if (result.success) {
                Logger.info('[LUKA-API] ✅ API key updated by ' + this.playerTracker._name);
                self.writeLine("━━━━━━━━━━━━━━━━━━━━");
                self.writeLine("✅ " + result.message);
                self.writeLine("Key: " + LukaAI.getApiKeyMasked());
                self.writeLine("━━━━━━━━━━━━━━━━━━━━");
            } else {
                Logger.warn('[LUKA-API] ❌ Update failed: ' + result.message);
                self.writeLine("━━━━━━━━━━━━━━━━━━━━");
                self.writeLine("❌ " + result.message);
                self.writeLine("Key unchanged");
                self.writeLine("━━━━━━━━━━━━━━━━━━━━");
            }
        } catch (err) {
            self.writeLine("❌ Error: " + err.message);
        }
    },

    shutdown: function (args) {
        if (!this.isFullAdmin() && this.playerTracker.userRole != UserRoleEnum.ADMIN) {
            this.writeLine(ErrorTextNoPermission);
            return;
        }
        Logger.warn("SHUTDOWN by " + this.playerTracker._name);
        process.exit(0);
    }
};
