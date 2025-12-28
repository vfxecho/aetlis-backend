#include <napi.h>
#include <algorithm>
#include <vector>
#include <cstdint>

struct Cell {
    double mass;
    int32_t birthTick;
    uint32_t originalIndex;
    
    inline bool operator>(const Cell& other) const {
        if (mass != other.mass) {
            return mass > other.mass;
        }
        return birthTick < other.birthTick;
    }
};

Napi::Value SortCells(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Expected an array").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Array cellsArray = info[0].As<Napi::Array>();
    uint32_t length = cellsArray.Length();

    if (length <= 1) {
        return cellsArray;
    }

    std::vector<Cell> cells;
    cells.reserve(length);

    for (uint32_t i = 0; i < length; ++i) {
        Napi::Value item = cellsArray[i];
        if (!item.IsObject()) continue;

        Napi::Object cellObj = item.As<Napi::Object>();
        
        Napi::Value massVal = cellObj.Get("_mass");
        Napi::Value birthTickVal = cellObj.Get("birthTick");

        if (!massVal.IsNumber() || !birthTickVal.IsNumber()) continue;

        cells.push_back({
            massVal.As<Napi::Number>().DoubleValue(),
            birthTickVal.As<Napi::Number>().Int32Value(),
            i
        });
    }

    std::sort(cells.begin(), cells.end(), [](const Cell& a, const Cell& b) {
        return a > b;
    });

    Napi::Array sortedArray = Napi::Array::New(env, cells.size());
    
    for (size_t i = 0; i < cells.size(); ++i) {
        sortedArray[i] = cellsArray[cells[i].originalIndex];
    }

    return sortedArray;
}

Napi::Value SortCellsInPlace(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Expected an array").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array cellsArray = info[0].As<Napi::Array>();
    uint32_t length = cellsArray.Length();

    if (length <= 1) {
        return env.Undefined();
    }

    std::vector<Cell> cells;
    std::vector<Napi::Value> cellObjects;
    cells.reserve(length);
    cellObjects.reserve(length);

    for (uint32_t i = 0; i < length; ++i) {
        Napi::Value item = cellsArray[i];
        if (!item.IsObject()) continue;

        Napi::Object cellObj = item.As<Napi::Object>();
        cellObjects.push_back(item);
        
        Napi::Value massVal = cellObj.Get("_mass");
        Napi::Value birthTickVal = cellObj.Get("birthTick");

        if (!massVal.IsNumber() || !birthTickVal.IsNumber()) continue;

        cells.push_back({
            massVal.As<Napi::Number>().DoubleValue(),
            birthTickVal.As<Napi::Number>().Int32Value(),
            i
        });
    }

    std::sort(cells.begin(), cells.end(), [](const Cell& a, const Cell& b) {
        return a > b;
    });

    for (size_t i = 0; i < cells.size(); ++i) {
        cellsArray[i] = cellObjects[cells[i].originalIndex];
    }

    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "sortCells"), 
                Napi::Function::New(env, SortCells));
    exports.Set(Napi::String::New(env, "sortCellsInPlace"), 
                Napi::Function::New(env, SortCellsInPlace));
    return exports;
}

NODE_API_MODULE(cell_sorter, Init)
