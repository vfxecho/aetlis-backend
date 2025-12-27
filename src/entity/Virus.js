var Cell = require('./Cell');
var Logger = require('../modules/Logger');

function Virus() {
    Cell.apply(this, Array.prototype.slice.call(arguments));
    this.cellType = 2;
    this.isSpiked = true;
    this.isMotherCell = false; // Not to confuse bots
    this.setColor({ r: 0x33, g: 0xff, b: 0x33 });
}

module.exports = Virus;
Virus.prototype = new Cell();

// Main Functions

Virus.prototype.canEat = function (cell) {
    // cannot eat if virusMaxAmount is reached
    if (this.gameServer.nodesVirus.length < this.gameServer.config.virusMaxAmount) {
        return cell.cellType == 3; // virus can eat ejected mass only
    }
};

Virus.prototype.onEat = function (prey) {
    // Called to eat prey cell
    var angle = Math.atan2(prey.boostDirection.x, prey.boostDirection.y);

    // Virus push: if enabled, only push the virus without growing or splitting
    if (this.gameServer.config.virusPush && this.gameServer.config.virusPushBoost) {
        var pushBoost = this.gameServer.config.virusPushBoost;
        var maxBoost = this.gameServer.config.virusMaxBoost;

        // Calculate new boost with cap
        var newBoost = this.boostDistance + pushBoost;
        if (newBoost > maxBoost) newBoost = maxBoost;

        // Combine boost directions (weighted average)
        var bx = this.boostDirection.x * this.boostDistance + prey.boostDirection.x * pushBoost;
        var by = this.boostDirection.y * this.boostDistance + prey.boostDirection.y * pushBoost;
        var norm = Math.sqrt(bx * bx + by * by);

        if (norm > 0) {
            this.boostDirection.x = bx / norm;
            this.boostDirection.y = by / norm;
        }

        this.boostDistance = newBoost;
        this.isMoving = true;

        // Add to moving nodes if not already there
        var index = this.gameServer.movingNodes.indexOf(this);
        if (index < 0) {
            // Track index for O(1) removal when collisionOptimization enabled
            if (this.gameServer.config.collisionOptimization) {
                this._movingIndex = this.gameServer.movingNodes.length;
            }
            this.gameServer.movingNodes.push(this);
        }

        // Exit early - do not grow or split when push is enabled
        return;
    }

    // Default behavior: grow and split when virusPush is disabled
    this.setSize(Math.sqrt(this._sizeSquared + prey._sizeSquared));

    if (this._size >= this.gameServer.config.virusMaxSize) {
        this.setSize(this.gameServer.config.virusMinSize); // Reset mass
        this.gameServer.shootVirus(this, angle);
    }
};

Virus.prototype.onEaten = function (c) {
    if (!c.owner) return; // Only players can explode

    // Track pop time for eject delay protection
    c.owner.lastPop = this.gameServer.tickCounter;

    // Convert minimum split size (radius) to mass
    var splitMinSize = this.gameServer.config.playerMinSplitSize;
    var splitMin = splitMinSize * splitMinSize / 100;

    var cellMass = c._mass;

    // Calculate max splits based on current cell mass
    var maxSplitsByMass = Math.floor(cellMass / splitMin);

    // Calculate available cell slots for player
    var maxSplitsBySlots = this.gameServer.config.playerMaxCells - c.owner.cells.length;

    // cellsLeft is the MINIMUM of both limits (mass-based and slot-based)
    var cellsLeft = Math.min(maxSplitsByMass, maxSplitsBySlots);

    if (cellsLeft <= 0) return; // cannot split

    var splits = [];

    if (this.gameServer.config.virusMonotonePop) {
        // All equal sizes (OgarX style) - monotone pop
        var amount = Math.min(Math.floor(cellMass / splitMin), cellsLeft);
        var perPiece = cellMass / (amount + 1);
        for (var i = 0; i < amount; i++) splits.push(perPiece);
    } else if (cellMass / cellsLeft < splitMin) {
        // Not enough mass to fill all slots at minimum, use 2^n distribution
        var amount = 2, perPiece = 0;
        while ((perPiece = cellMass / (amount + 1)) >= splitMin && amount * 2 <= cellsLeft)
            amount *= 2;
        for (var i = 0; i < amount; i++) splits.push(perPiece);
    } else {
        // Diverse distribution like OgarX
        var nextMass = cellMass / 2;
        var massLeft = cellMass / 2;
        while (cellsLeft > 0) {
            if (nextMass / cellsLeft < splitMin) break;
            while (nextMass >= massLeft && cellsLeft > 1)
                nextMass /= 2;
            splits.push(nextMass);
            massLeft -= nextMass;
            cellsLeft--;
        }
        if (cellsLeft > 0) {
            var remainder = massLeft / cellsLeft;
            for (var i = 0; i < cellsLeft; i++) splits.push(remainder);
        }
    }

    // Create splits
    for (var k = 0; k < splits.length; k++) {
        var angle = 2 * Math.PI * Math.random();
        this.gameServer.splitPlayerCell(c.owner, c, angle, splits[k]);
    }
};

Virus.prototype.onAdd = function (gameServer) {
    gameServer.nodesVirus.push(this);
};

Virus.prototype.onRemove = function (gameServer) {
    var index = gameServer.nodesVirus.indexOf(this);
    if (index != -1)
        gameServer.nodesVirus.splice(index, 1);
};
