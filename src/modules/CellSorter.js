var Logger = require('./Logger');

var CellSorter = {
    nativeModule: null,
    useNative: false,
    
    init: function() {
        try {
            this.nativeModule = require('../../build/Release/cell_sorter.node');
            this.useNative = true;
            Logger.info('[CellSorter] Native C++ loaded');
        } catch (err) {
            this.useNative = false;
            Logger.warn('[CellSorter] Using JS fallback');
            Logger.debug('[CellSorter] ' + err.message);
        }
    },
    
    sortCells: function(cells) {
        if (!cells || cells.length <= 1) {
            return cells;
        }
        
        if (this.useNative && this.nativeModule) {
            try {
                return this.nativeModule.sortCells(cells);
            } catch (err) {
                Logger.warn('[CellSorter] Native failed, using JS: ' + err.message);
                this.useNative = false;
            }
        }
        
        return cells.slice().sort(function(a, b) {
            var massDiff = b._mass - a._mass;
            if (massDiff !== 0) return massDiff;
            return a.birthTick - b.birthTick;
        });
    },
    
    sortCellsInPlace: function(cells) {
        if (!cells || cells.length <= 1) {
            return;
        }
        
        if (this.useNative && this.nativeModule) {
            try {
                this.nativeModule.sortCellsInPlace(cells);
                return;
            } catch (err) {
                Logger.warn('[CellSorter] Native failed, using JS: ' + err.message);
                this.useNative = false;
            }
        }
        
        cells.sort(function(a, b) {
            var massDiff = b._mass - a._mass;
            if (massDiff !== 0) return massDiff;
            return a.birthTick - b.birthTick;
        });
    },
    
    isUsingNative: function() {
        return this.useNative;
    }
};

module.exports = CellSorter;

