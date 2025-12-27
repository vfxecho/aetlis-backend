function Cell(gameServer, owner, position, size) {
    this.gameServer = gameServer;
    this.owner = owner;     // playerTracker that owns this cell

    this.tickOfBirth = 0;
    this.color = { r: 0, g: 0, b: 0 };
    this.position = { x: 0, y: 0 };
    this._sizeSquared = 0;
    this._size = 0;
    this._mass = 0;
    this.cellType = -1;     // 0 = Player Cell, 1 = Food, 2 = Virus, 3 = Ejected Mass
    this.isSpiked = false;  // If true, then this cell has spikes around it
    this.isAgitated = false;// If true, then this cell has waves on it's outline
    this.killedBy = null;   // Cell that ate this cell
    this.isMoving = false;  // Indicate that cell is in boosted mode
    this.boostDistance = 0;
    this.boostDirection = { x: 1, y: 0, angle: Math.PI / 2 };

    if (this.gameServer) {
        this.tickOfBirth = this.gameServer.tickCounter;
        this.nodeId = this.gameServer.lastNodeId++ >> 0;
        if (size) this.setSize(size);
        // CRITICAL: Clone position object to avoid reference sharing between cells
        // Without this, virus pop creates cells that all share the same position object
        // causing minimap teleportation when any one of them moves
        if (position) {
            this.position.x = position.x;
            this.position.y = position.y;
        }
    }
}

module.exports = Cell;

// Fields not defined by the constructor are considered private and need a getter/setter to access from a different class

Cell.prototype.setColor = function (color) {
    this.color.r = color.r;
    this.color.g = color.g;
    this.color.b = color.b;
};

Cell.prototype.setSize = function (size) {
    this._size = size;
    this._sizeSquared = size * size;
    this._mass = this._sizeSquared / 100;
    if (this.owner)
        this.owner.isMassChanged = true;
};

// by default cell cannot eat anyone
Cell.prototype.canEat = function (cell) {
    return false;
};

// Returns cell age in ticks for specified game tick
Cell.prototype.getAge = function () {
    if (this.tickOfBirth == null) return 0; // age cant be less than 0
    return Math.max(0, this.gameServer.tickCounter - this.tickOfBirth);
};

// Called to eat prey cell
Cell.prototype.onEat = function (prey) {
    if (!this.gameServer.config.playerBotGrow) {
        if (this._size >= 250 && prey._size <= 41 && prey.cellType == 0)
            prey._sizeSquared = 0; // Can't grow from players under 17 mass
    }
    this.setSize(Math.sqrt(this._sizeSquared + prey._sizeSquared));
};

Cell.prototype.setBoost = function (distance, angle) {
    this.boostDistance = distance;
    this.boostDirection = {
        x: Math.sin(angle),
        y: Math.cos(angle),
    };
    this.isMoving = true;
    if (!this.owner) {
        var index = this.gameServer.movingNodes.indexOf(this);
        if (index < 0) {
            // Track index for O(1) removal when collisionOptimization enabled
            if (this.gameServer.config.collisionOptimization) {
                this._movingIndex = this.gameServer.movingNodes.length;
            }
            this.gameServer.movingNodes.push(this);
        }
    }
};

Cell.prototype.checkBorder = function (border) {
    // Border kills cells mode - NO wall physics, only death after grace zone
    if (this.gameServer && this.gameServer.config.borderKillsCells) {
        var borderGrace = this.gameServer.config.borderKillsGrace || 200;

        if (this.gameServer.config.worldIsCircular) {
            // Circular map - check distance from center
            var radius = this.gameServer.config.worldRadius;
            var killDistance = radius + borderGrace;
            var dx = this.position.x;
            var dy = this.position.y;
            var distanceFromCenter = Math.sqrt(dx * dx + dy * dy);

            // Kill only player cells when past grace zone (ejected mass stays alive)
            if (this.cellType === 0 && distanceFromCenter > killDistance) {
                this._borderKilled = true;
            }
        } else {
            // Rectangular map
            var pastKillZone =
                this.position.x < border.minx - borderGrace ||
                this.position.y < border.miny - borderGrace ||
                this.position.x > border.maxx + borderGrace ||
                this.position.y > border.maxy + borderGrace;

            // Kill only player cells when past grace zone (ejected mass stays alive)
            if (this.cellType === 0 && pastKillZone) {
                this._borderKilled = true;
            }
        }
        // No wall physics - cells pass freely through border
        return;
    }

    // TOURNAMENT MODE: Bots can pass through borders during active tournament
    // This allows bots to be pushed outside by shrinking border and die
    // Normal mode (non-tournament): Bots are clamped like players
    if (this.owner && this.owner.isBot) {
        var tm = this.gameServer && this.gameServer.tournamentManager;
        if (tm && tm.isActive) {
            return; // No wall physics for bots in tournament
        }
    }

    // Normal mode - apply wall physics (clamping)
    if (this.gameServer && this.gameServer.config.worldIsCircular) {
        var radius = this.gameServer.config.worldRadius;
        var cellRadius = this._size / 2;
        var maxDistance = radius - cellRadius;
        var dx = this.position.x;
        var dy = this.position.y;
        var distanceFromCenter = Math.sqrt(dx * dx + dy * dy);

        if (distanceFromCenter > maxDistance) {
            var angle = Math.atan2(dy, dx);
            this.position.x = Math.cos(angle) * maxDistance;
            this.position.y = Math.sin(angle) * maxDistance;
        }
    } else {
        var halfSize = this._size / 2;
        this.position.x = Math.max(this.position.x, border.minx + halfSize);
        this.position.y = Math.max(this.position.y, border.miny + halfSize);
        this.position.x = Math.min(this.position.x, border.maxx - halfSize);
        this.position.y = Math.min(this.position.y, border.maxy - halfSize);
    }
};

Cell.prototype.onEaten = function (hunter) { };
Cell.prototype.onAdd = function (gameServer) { };
Cell.prototype.onRemove = function (gameServer) { };
