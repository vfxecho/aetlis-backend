// Import
var BinaryWriter = require("./BinaryWriter");
var Logger = require("../modules/Logger");


function UpdateLeaderboard(playerTracker, leaderboard, leaderboardType) {
    this.playerTracker = playerTracker;
    this.leaderboard = leaderboard;
    this.leaderboardType = leaderboardType;
    this.leaderboardCount = Math.min(leaderboard.length, playerTracker.gameServer.config.serverMaxLB);
}

module.exports = UpdateLeaderboard;

UpdateLeaderboard.prototype.build = function (protocol) {
    // Logger.debug('[LB-BUILD] Protocol: ' + protocol + ', Type: 0x' + this.leaderboardType.toString(16) + ', Count: ' + this.leaderboardCount);

    switch (this.leaderboardType) {
        case 0x30:
            // UserText
            // Logger.debug('[LB-BUILD] Building UserText');
            if (protocol < 11)
                return this.buildUserText6(protocol);
            else
                return this.buildUserText11();
        case 0x31:
            // FFA
            // Logger.debug('[LB-BUILD] Building FFA - protocol=' + protocol);
            if (protocol < 6)
                return this.buildFfa5();
            else if (protocol < 11)
                return this.buildFfa6();
            else {
                // Logger.debug('[LB-BUILD] Using buildFfa11()');
                return this.buildFfa11();
            }
        case 0x32:
            // Team
            // Logger.debug('[LB-BUILD] Building Team');
            return this.buildTeam();
        default:
            // Logger.debug('[LB-BUILD] Unknown type: 0x' + this.leaderboardType.toString(16));
            return null;
    }
}

// UserText
UpdateLeaderboard.prototype.buildUserText6 = function (protocol) {
    var writer = new BinaryWriter();
    writer.writeUInt8(protocol < 6 ? 0x31 : 0x30);
    writer.writeUInt32(this.leaderboard.length >>> 0);
    for (var i = 0; i < this.leaderboard.length; i++) {
        var item = this.leaderboard[i] || "";

        if (protocol < 6)
            writer.writeUInt32(0);

        if (protocol < 6)
            writer.writeStringZeroUnicode(item);
        else
            writer.writeStringZeroUtf8(item);
    }
    return writer.toBuffer();
};

UpdateLeaderboard.prototype.buildUserText11 = function () {
    var writer = new BinaryWriter();
    writer.writeUInt8(0x31);
    writer.writeUInt32(this.leaderboard.length >>> 0);
    for (var i = 0; i < this.leaderboard.length; i++) {
        var item = this.leaderboard[i] || "";

        writer.writeStringZeroUtf8(item);
    }
    return writer.toBuffer();
};


// FFA protocol 5
UpdateLeaderboard.prototype.buildFfa5 = function () {
    var player = this.playerTracker;

    var writer = new BinaryWriter();
    writer.writeUInt8(0x31);                               // Packet ID
    writer.writeUInt32(this.leaderboardCount >>> 0);       // Number of elements
    for (var i = 0; i < this.leaderboardCount; i++) {
        var item = this.leaderboard[i];
        if (item == null) return null;  // bad leaderboardm just don't send it

        var name = item._nameUnicode;
        var id = 0;
        if (item == player && item.cells.length > 0)
            id = item.cells[0].nodeId ^ this.playerTracker.scrambleId;


        writer.writeUInt32(id >>> 0);   // Player cell Id
        if (name != null)
            writer.writeBytes(name);
        else
            writer.writeUInt16(0);
    }
    return writer.toBuffer();
};

// FFA protocol 6
UpdateLeaderboard.prototype.buildFfa6 = function () {
    var player = this.playerTracker;

    var writer = new BinaryWriter();
    writer.writeUInt8(0x31);                               // Packet ID
    writer.writeUInt32(this.leaderboardCount >>> 0);       // Number of elements
    for (var i = 0; i < this.leaderboardCount; i++) {
        var item = this.leaderboard[i];
        if (item == null) return null;   // bad leaderboardm just don't send it

        var name = item._nameUtf8;
        var id = item == player ? 1 : 0;

        writer.writeUInt32(id >>> 0);   // isMe flag
        if (name != null)
            writer.writeBytes(name);
        else
            writer.writeUInt8(0);
    }
    return writer.toBuffer();
};

// FFA protocol 11 (standard Vanis format - names only)
UpdateLeaderboard.prototype.buildFfa11 = function () {
    var player = this.playerTracker;

    var writer = new BinaryWriter();
    writer.writeUInt8(0x31);                                 // Packet ID (49 decimal)
    writer.writeUInt32(this.leaderboardCount >>> 0);         // Number of elements

    for (var i = 0; i < this.leaderboardCount; i++) {
        var item = this.leaderboard[i];
        if (item == null) return null;  // Skip invalid leaderboard entry

        var pid = (item.pID != null ? item.pID : 0) & 0xFFFF;
        writer.writeUInt16(pid >>> 0);                       // Player ID for reliable client matching

        var name = item._name;
        if (name != null && name.length) {
            // Remove U+FDFD (﷽) ligature which breaks UI
            // Also truncate to 12 chars as a safety measure
            name = name.replace(/\uFDFD/g, "");

            if (name.length > 12) name = name.substring(0, 12);
            writer.writeStringZeroUtf8(name);
        } else {
            writer.writeUInt8(0);
        }
    }

    return writer.toBuffer();
};

// Team
UpdateLeaderboard.prototype.buildTeam = function () {
    var writer = new BinaryWriter();
    writer.writeUInt8(0x32);                                // Packet ID
    writer.writeUInt32(this.leaderboard.length >>> 0);       // Number of elements
    for (var i = 0; i < this.leaderboard.length; i++) {
        var value = this.leaderboard[i];
        if (value == null) return null;  // bad leaderboardm just don't send it

        if (isNaN(value)) value = 0;
        value = value < 0 ? 0 : value;
        value = value > 1 ? 1 : value;

        writer.writeFloat(value);                // isMe flag (previously cell ID)
    }
    return writer.toBuffer();
};
