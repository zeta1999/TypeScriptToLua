export const luaKeywords: Set<string> = new Set([
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local", "nil",
    "not", "or", "repeat", "return", "then", "until", "while",
]);

export const luaBuiltins: Set<string> = new Set([
    "_G", "assert", "coroutine", "debug", "error", "ipairs", "math", "pairs", "pcall", "print", "rawget", "rawset",
    "repeat", "require", "self", "string", "table", "tostring", "type", "unpack",
]);
