#include <napi.h>
#include <algorithm>
#include <vector>
#include <cstdint>


// Uses boostDistance > 0 for boost check, _size for size comparison
// NO age tie-breaker
struct Cell {
    double size;         //  _size
    double boostDistance; // boostDistance > 0
    uint32_t originalIndex;
    

    // 1. Boosting cells first (boostDistance > 0)
    // 2. Larger cells first (by _size)
    // NO tie-breaker!
    inline bool operator>(const Cell& other) const {
        //  a.boostDistance > 0 ? 1 : 0
        bool aBoosting = boostDistance > 0;
        bool bBoosting = other.boostDistance > 0;
        if (aBoosting != bBoosting) {
            return aBoosting;  // boosting cells eat/process first
        }
        // b._size - a._size (bigger first)
        return size > other.size;
    }
};

// Arguments: [cellsArray, sizeArray, boostArray, length]
Napi::Value SortCells(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Expected 4 arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Array cellsArray = info[0].As<Napi::Array>();
    Napi::Float64Array sizeArray = info[1].As<Napi::Float64Array>();
    Napi::Float64Array boostArray = info[2].As<Napi::Float64Array>();
    uint32_t length = info[3].As<Napi::Number>().Uint32Value();

    if (length <= 1) {
        return cellsArray;
    }

    double* sizes = sizeArray.Data();
    double* boosts = boostArray.Data();

    std::vector<Cell> cells;
    cells.reserve(length);

    for (uint32_t i = 0; i < length; ++i) {
        cells.push_back({
            sizes[i],
            boosts[i],
            i
        });
    }

    std::stable_sort(cells.begin(), cells.end(), [](const Cell& a, const Cell& b) {
        return a > b;
    });

    Napi::Array sortedArray = Napi::Array::New(env, length);
    
    for (size_t i = 0; i < length; ++i) {
        sortedArray[i] = cellsArray[cells[i].originalIndex];
    }

    return sortedArray;
}

// Arguments: [cellsArray, sizeArray, boostArray, length]
Napi::Value SortCellsInPlace(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Expected 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array cellsArray = info[0].As<Napi::Array>();
    Napi::Float64Array sizeArray = info[1].As<Napi::Float64Array>();
    Napi::Float64Array boostArray = info[2].As<Napi::Float64Array>();
    uint32_t length = info[3].As<Napi::Number>().Uint32Value();

    if (length <= 1) {
        return env.Undefined();
    }

    double* sizes = sizeArray.Data();
    double* boosts = boostArray.Data();

    std::vector<Cell> cells;
    std::vector<Napi::Value> cellObjects;
    cells.reserve(length);
    cellObjects.reserve(length);

    // We still need to keep a reference to objects to swap them back
    for (uint32_t i = 0; i < length; ++i) {
        cellObjects.push_back(cellsArray[i]); // This might be slow? property access on array is faster than object property access
        cells.push_back({
            sizes[i],
            boosts[i],
            i
        });
    }

    std::stable_sort(cells.begin(), cells.end(), [](const Cell& a, const Cell& b) {
        return a > b;
    });

    for (size_t i = 0; i < length; ++i) {
        cellsArray[i] = cellObjects[cells[i].originalIndex];
    }

    return env.Undefined();
}

// =============================================
// sortEatCollisions
// Sorts eat collision pairs by boost priority
// =============================================
// Arguments: [collisionsArray, sizeArray, boostArray, length]
Napi::Value SortEatCollisions(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Expected 4 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array collisionsArray = info[0].As<Napi::Array>();
    Napi::Float64Array sizeArray = info[1].As<Napi::Float64Array>();
    Napi::Float64Array boostArray = info[2].As<Napi::Float64Array>();
    uint32_t length = info[3].As<Napi::Number>().Uint32Value();

    if (length <= 1) {
        return env.Undefined();
    }

    double* sizes = sizeArray.Data();
    double* boosts = boostArray.Data();

    struct EatCollision {
        double cellSize;
        double cellBoostDistance;
        uint32_t originalIndex;
        
        inline bool operator>(const EatCollision& other) const {
            // lets try this for now/
            bool aBoosting = cellBoostDistance > 0;
            bool bBoosting = other.cellBoostDistance > 0;
            if (aBoosting != bBoosting) {
                return aBoosting;
            }
            return cellSize > other.cellSize;
        }
    };

    std::vector<EatCollision> collisions;
    std::vector<Napi::Value> collisionObjects;
    collisions.reserve(length);
    collisionObjects.reserve(length);

    for (uint32_t i = 0; i < length; ++i) {
        collisionObjects.push_back(collisionsArray[i]);
        collisions.push_back({
            sizes[i],
            boosts[i],
            i
        });
    }

    std::stable_sort(collisions.begin(), collisions.end(), [](const EatCollision& a, const EatCollision& b) {
        return a > b;
    });

    // Reorder array in-place
    for (size_t i = 0; i < collisions.size(); ++i) {
        collisionsArray[i] = collisionObjects[collisions[i].originalIndex];
    }

    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "sortCells"), 
                Napi::Function::New(env, SortCells));
    exports.Set(Napi::String::New(env, "sortCellsInPlace"), 
                Napi::Function::New(env, SortCellsInPlace));
    exports.Set(Napi::String::New(env, "sortEatCollisions"), 
                Napi::Function::New(env, SortEatCollisions));
    return exports;
}

NODE_API_MODULE(cell_sorter, Init)

