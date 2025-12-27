var Cell = require('./Cell');

function PlayerCell() {
    Cell.apply(this, Array.prototype.slice.call(arguments));
    this.cellType = 0;
    this._canRemerge = false;

    // Root cell tracking for mouse projection (linesplit)
    this.isRootCell = false;
    this.rootCellId = 0;
    this.birthTick = this.gameServer ? this.gameServer.tickCounter : 0;
}

module.exports = PlayerCell;
PlayerCell.prototype = new Cell();

// Main Functions

PlayerCell.prototype.canEat = function (cell) {
    return true; // player cell can eat anyone
};

// Override onEat to add XP when eating food
PlayerCell.prototype.onEat = function (prey) {
    // XP System: Give XP when eating food (cellType 1)
    if (prey.cellType === 1 && this.owner && !this.owner.isMinion) {
        var foodMass = prey._mass;

        // Total XP: Uses level coefficient (slows down at high levels)
        var xpCoefficient = this.owner.getPelletXPCoefficient ? this.owner.getPelletXPCoefficient() : 0.40;
        var totalXP = Math.max(1, Math.floor(foodMass * xpCoefficient * 10));

        // Season XP: Flat rate for everyone (fair seasonal competition)
        var seasonXP = Math.max(1, Math.floor(foodMass * 0.40 * 10));

        // Give both XP values to player
        if (this.owner.addXP) {
            this.owner.addXP(totalXP, seasonXP);
        }
    }

    // Apply size increase (original logic from Cell.prototype.onEat)
    if (!this.gameServer.config.playerBotGrow) {
        if (this._size >= 250 && prey._size <= 41 && prey.cellType == 0)
            prey._sizeSquared = 0; // Can't grow from players under 17 mass
    }
    this.setSize(Math.sqrt(this._sizeSquared + prey._sizeSquared));
};

PlayerCell.prototype.getSpeed = function (dist) {
    // Luka's OgarII formula from github.com/Luka967/OgarII
    // 88 * Math.pow(size, -0.4396754) * playerSpeedMult
    var speed = 88 * Math.pow(this._size, -0.4396754);
    var normalizedDist = Math.min(dist, 32) * 0.03125;
    speed *= this.gameServer.config.playerSpeed;
    return speed * normalizedDist / dist;
};

PlayerCell.prototype.onAdd = function (gameServer) {
    gameServer.nodesPlayer.unshift(this);
};

PlayerCell.prototype.onRemove = function (gameServer) {
    // Remove from owned cell list (skip for dead cells with no owner)
    if (this.owner && this.owner.cells) {
        var index = this.owner.cells.indexOf(this);
        if (index != -1) {
            this.owner.cells.splice(index, 1);
            // Disable mergeOverride on the last merging cell
            if (this.owner.cells.length <= 2)
                this.owner.mergeOverride = false;
        }
    }

    // Remove from player cell list
    var index = gameServer.nodesPlayer.indexOf(this);
    if (index != -1) gameServer.nodesPlayer.splice(index, 1);

    // Gamemode actions
    gameServer.gameMode.onCellRemove(this);
};
