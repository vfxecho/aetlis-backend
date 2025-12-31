var Logger = require('./Logger');

var CellSorter = {
    nativeModule: null,
    useNative: false,

    // Reusable buffers to avoid allocation pressure
    // We'll expand them if needed
    _sizeBuffer: new Float64Array(10000),
    _boostBuffer: new Float64Array(10000),

    init: function () {
        try {
            // Try different paths for flexibility (production/dev)
            try {
                this.nativeModule = require('../../build/Release/cell_sorter.node');
            } catch (e) {
                this.nativeModule = require('../../native/cell_sorter.node');
            }

            this.useNative = true;
            Logger.info('[CellSorter] Native C++ loaded (Optimized TypedArray implementation)');
            Logger.info('[CellSorter] Exports: ' + Object.keys(this.nativeModule).join(', '));
        } catch (err) {
            this.useNative = false;
            Logger.fatal('[CellSorter] FAILED TO LOAD NATIVE MODULE: ' + err.message);
            Logger.fatal('[CellSorter] Sorting will NOT work correctly. User requested NO FALLBACK.');
        }
    },

    _ensureBufferSize: function (length) {
        if (this._sizeBuffer.length < length) {
            // Exponential growth to minimize future allocations
            var newLength = Math.max(length, this._sizeBuffer.length * 2);
            this._sizeBuffer = new Float64Array(newLength);
            this._boostBuffer = new Float64Array(newLength);
            Logger.debug('[CellSorter] Resized buffers to ' + newLength);
        }
    },

    sortCells: function (cells) {
        if (!cells || cells.length <= 1) {
            return cells;
        }

        if (this.useNative && this.nativeModule) {
            var length = cells.length;
            this._ensureBufferSize(length);

            // Populate buffers
            for (var i = 0; i < length; i++) {
                var cell = cells[i];
                // Handle potential null/undefined cells or properties safely
                if (cell) {
                    this._sizeBuffer[i] = cell._size || 0;
                    this._boostBuffer[i] = (cell.boostDistance || 0); // numeric value
                } else {
                    this._sizeBuffer[i] = 0;
                    this._boostBuffer[i] = 0;
                }
            }

            // Pass buffers to native module
            // We pass the actual length used, so C++ knows how many bounds to read
            return this.nativeModule.sortCells(cells, this._sizeBuffer, this._boostBuffer, length);
        }
        // NO FALLBACK
        return cells;
    },

    sortCellsInPlace: function (cells) {
        if (!cells || cells.length <= 1) {
            return;
        }

        if (this.useNative && this.nativeModule) {
            var length = cells.length;
            this._ensureBufferSize(length);

            for (var i = 0; i < length; i++) {
                var cell = cells[i];
                if (cell) {
                    this._sizeBuffer[i] = cell._size || 0;
                    this._boostBuffer[i] = (cell.boostDistance || 0);
                } else {
                    this._sizeBuffer[i] = 0;
                    this._boostBuffer[i] = 0;
                }
            }

            // sortCellsInPlace modifies the array in-place
            this.nativeModule.sortCellsInPlace(cells, this._sizeBuffer, this._boostBuffer, length);
            return;
        }
        // NO FALLBACK
    },

    sortEatCollisions: function (collisions) {
        if (!collisions || collisions.length <= 1) {
            return;
        }

        if (this.useNative && this.nativeModule) {
            var length = collisions.length;
            this._ensureBufferSize(length);

            for (var i = 0; i < length; i++) {
                var item = collisions[i];
                // collision object structure: { manifold, cell, check }
                // We sort based on item.cell properties
                if (item && item.cell) {
                    this._sizeBuffer[i] = item.cell._size || 0;
                    this._boostBuffer[i] = (item.cell.boostDistance || 0);
                } else {
                    this._sizeBuffer[i] = 0;
                    this._boostBuffer[i] = 0;
                }
            }

            this.nativeModule.sortEatCollisions(collisions, this._sizeBuffer, this._boostBuffer, length);
            return;
        }
        // NO FALLBACK
    },

    isUsingNative: function () {
        return this.useNative;
    }
};

// Auto-initialize when required
CellSorter.init();

module.exports = CellSorter;
