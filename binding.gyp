{
  "targets": [
    {
      "target_name": "cell_sorter",
      "sources": [ "native/cell_sorter.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags": [ "-O3", "-march=native", "-ffast-math" ],
      "cflags_cc": [ "-O3", "-march=native", "-ffast-math", "-std=c++17" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7",
        "GCC_OPTIMIZATION_LEVEL": "3",
        "OTHER_CFLAGS": [ "-O3", "-march=native", "-ffast-math" ],
        "OTHER_CPLUSPLUSFLAGS": [ "-O3", "-march=native", "-ffast-math", "-std=c++17" ]
      },
      "msvs_settings": {
        "VCCLCompilerTool": { 
          "ExceptionHandling": 1,
          "Optimization": 3,
          "FavorSizeOrSpeed": 1,
          "InlineFunctionExpansion": 2
        }
      }
    }
  ]
}
