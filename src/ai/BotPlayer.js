var PlayerTracker = require('../PlayerTracker');
var Vector = require('vector2-node');

function BotPlayer() {
    PlayerTracker.apply(this, Array.prototype.slice.call(arguments));
    this.splitCooldown = 0;
    this.targetPursuit = 0;  // How many consecutive ticks should move to the split target
    this.splitTarget = null; // The split target to pursuit
    this.isBot = true; // Mark this player as a bot for client rendering
    this.waitTime = 0; // Delay before split
}
module.exports = BotPlayer;
BotPlayer.prototype = new PlayerTracker();


BotPlayer.prototype.largest = function (list) {
    if (!list.length) return null; // Error!

    // Sort the cells by Array.sort() function to avoid errors
    var sorted = list.valueOf();
    sorted.sort(function (a, b) {
        return b._size - a._size;
    });
    return sorted[0];
};

BotPlayer.prototype.checkConnection = function () {
    // Respawn if bot is dead
    if (!this.cells.length) {
        this.gameServer.gameMode.onPlayerSpawn(this.gameServer, this);
        if (!this.cells.length)
            // If the bot cannot spawn any cells, then disconnect it
            this.socket.close();
    }
};

// Override the update function from player tracker
BotPlayer.prototype.sendUpdate = function () {
    // If frozen (e.g. tournament not started yet), don't move or take any action
    if (this.frozen) {
        return;
    }

    if (this.splitCooldown) this.splitCooldown--;

    // PERFORMANCE TEST MODE
    // Bots behave chaotically to stress test collision system
    if (this.gameServer.config.performTest) {
        this.performTestBehavior();
        return;
    }

    this.decide(this.largest(this.cells)); // Action
};

// Performance test behavior - random splits and ejects
BotPlayer.prototype.performTestBehavior = function () {
    var cell = this.largest(this.cells);
    if (!cell) return;

    // Random mouse movement
    var border = this.gameServer.border;
    this.mouse = {
        x: border.minx + Math.random() * (border.maxx - border.minx),
        y: border.miny + Math.random() * (border.maxy - border.miny)
    };

    // Random actions (adjusted probabilities for stress testing)
    var rand = Math.random();

    // 20% chance to split (if can split)
    if (rand < 0.20 && !this.splitCooldown && this.cells.length < this.gameServer.config.playerMaxCells) {
        if (cell._size >= this.gameServer.config.playerMinSplitSize) {
            this.socket.packetHandler.pressSpace = true;
            this.splitCooldown = 5; // Short cooldown for stress testing
        }
    }

    // 15% chance to eject
    if (rand > 0.85 && cell._size >= this.gameServer.config.playerMinEjectSize) {
        this.socket.packetHandler.pressW = true;
    }

    // 5% chance to multi-split (double/triple)
    if (rand > 0.95 && !this.splitCooldown && this.cells.length < 4) {
        if (cell._size >= this.gameServer.config.playerMinSplitSize * 2) {
            // Queue multiple splits
            this.socket.packetHandler.pressSpace = true;
            var self = this;
            setTimeout(function () {
                if (self.socket && self.socket.packetHandler) {
                    self.socket.packetHandler.pressSpace = true;
                }
            }, 50);
            this.splitCooldown = 10;
        }
    }
};

// Custom
BotPlayer.prototype.decide = function (cell) {
    if (this.splitTarget) {
        // Attack recent split target
        if (this.splitTarget.isRemoved) {
            // Target is dead
            this.splitTarget = null;
            this.targetPursuit = 0;
        }
        if (this.targetPursuit <= 0) this.splitTarget = null;
        else {
            // Continue pursuit
            this.targetPursuit--;
            this.mouse = {
                x: this.splitTarget.position.x,
                y: this.splitTarget.position.y
            };
            return;
        }
    }
    if (!cell) return; // Cell was eaten, check in the next tick
    var result = new Vector(0, 0),
        predators = [],
        bestPrey = null,
        instantRemerge = this.gameServer.config.playerRecombineTime <= 0 || this.rec,
        minimumMult = instantRemerge ? .1 : .4,
        checkForPrey = (this.cells.length * 2 <= 8) && !this.splitCooldown,
        splitCellSize = cell._size / 1.41421356;

    for (var i = 0; i < this.viewNodes.length; i++) {
        var check = this.viewNodes[i];
        if (check.owner === this) continue;

        // Get attraction of the cells - avoid larger cells, viruses and same team cells
        var influence = 0;
        if (check.cellType === 0) {
            // Player cell
            if ((this.gameServer.gameMode.haveTeams && (cell.owner.team == check.owner.team)) ||
                (this.gameServer.tournamentManager && this.gameServer.tournamentManager.isActive))
                // Same team cell OR Tournament Mode (bots ignore players)
                continue;
            else if (cell._size > check._size * 1.1401)
                // Can eat it - prioritize over food
                influence = 0; // USER REQUEST: Don't move towards players
            else if (check._size > cell._size * 1.1401) {
                // Avoid it - prioritize large cells over everything
                influence = -Math.log(check._size / cell._size);

                // Add to predator list to consider if it can kill me when I split
                if (check._size > splitCellSize * 1.1401 &&
                    distance < Math.max(6 * cell._size, this.gameServer.config.splitVelocity))
                    predators.push(check);
            } else
                // Ignore it
                influence = -check._size / cell._size;
        } else if (check.cellType === 1)
            // Food
            influence = 1;
        else if (check.cellType === 2) {
            // Virus/Mothercell
            if (check.isMotherCell)
                // Always ignore mothercell
                influence = -1;
            else if (cell._size > check._size * 1.1401) {
                // Can eat it
                if (this.cells.length >= this.gameServer.config.playerMaxCells)
                    // Won't explode
                    influence = 2;
                else
                    // Avoid it - prioritize over everything
                    influence = -1;
            }
        } else if (check.cellType === 3) {
            // Ejected mass - ignore (User request: target only pellets)
            influence = 0;
        }

        // Division by 0 check
        if (influence === 0 && check.cellType !== 0)
            continue;

        // Calculate separation between cell and check
        var displacement = new Vector(check.position.x - cell.position.x, check.position.y - cell.position.y);

        // Get distance between cells
        var distance = displacement.length();
        if (influence < 0)
            // Get edge distance
            distance -= cell._size + check._size;

        // The farther they are the smaller influnce it is
        // Less than 1 distance will amplify influence (virus popping dangers)
        if (distance < 1) distance = 1;
        influence /= distance;

        // Produce force vector
        var force = displacement.normalize().scale(influence);

        if (checkForPrey && check.cellType === 0) {
            // Split-cell eat check, small prey check, distance check
            if (splitCellSize > check._size * 1.1401
                && cell._size * minimumMult < check._size
                && this.canSplitkill(cell, check, distance)) {

                if (bestPrey) {
                    // Prioritize larger prey
                    if (check._size > bestPrey._size)
                        bestPrey = check;
                } else bestPrey = check;
            }
        }

        // Add up force
        result.add(force);
    }

    // Normalize the resulting vector
    result.normalize();

    // Set bot's mouse position
    this.mouse = {
        x: cell.position.x + result.x * this.viewBox.halfWidth,
        y: cell.position.y + result.y * this.viewBox.halfWidth
    };

    // No mouse clamping - Cell.js handles border physics:
    // - Tournament mode: bots can pass through borders
    // - Normal mode: bots are clamped by checkBorder()

    // Split-kill check (overrides this.mouse if attacking)
    if (bestPrey != null) {
        // TOURNAMENT MODE: Make bots dumb - NEVER split
        // This makes them easier to eat and pure mass for tournament players
        var tm = this.gameServer.tournamentManager;
        if (tm && tm.isActive) {
            // Never split in tournament mode - bots are just food
            this.waitTime = 0;
            return;
        }

        // Nearby virus check
        var sizeEat = Math.sqrt(splitCellSize * splitCellSize + check._sizeSquared) + 40;
        if (this.gameServer.finder.any({
            minx: bestPrey.position.x - sizeEat,
            miny: bestPrey.position.y - sizeEat,
            maxx: bestPrey.position.x + sizeEat,
            maxy: bestPrey.position.y + sizeEat
        },
            function (a) {
                return a.cellType === 2;
            })) {

            // A virus is where I'll split-kill the player - don't split
            this.waitTime = 0;
            return;
        }
        // Split-kill prey
        this.mouse = {
            x: bestPrey.position.x,
            y: bestPrey.position.y
        };

        // Delay logic - wait 13 ticks before splitting
        if (this.waitTime <= 0) {
            this.waitTime = 13;
            return;
        }
        this.waitTime--;
        if (this.waitTime > 0) return;

        this.splitTarget = bestPrey;
        this.targetPursuit = instantRemerge ? 5 : 20;
        this.splitCooldown = instantRemerge ? 6 : 21;
        this.socket.packetHandler.pressSpace = true;
        this.waitTime = 0; // Reset after action
    } else {
        this.waitTime = 0; // Reset if target lost
    }
};

BotPlayer.prototype.canSplitkill = function (cell, check, distance) {
    if (check.cellType === 2)
        // Swap playerSplitVelocity with virusVelocity
        return this.gameServer.config.virusVelocity * 1.3 - cell._size / 2 - check._size >= distance;
    var splitDist = Math.max(this.gameServer.config.splitVelocity * 0.8, cell._size / 1.41421356 * 4.5);
    return splitDist >= distance;
};
