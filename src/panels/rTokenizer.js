
var hljsR = function(e) {
  var r = e.regex, a = /(?:(?:[a-zA-Z]|\.[._a-zA-Z])[._a-zA-Z0-9]*)|./, n = {
    className: "string",
    contains: [e.BACKSLASH_ESCAPE],
    variants: [
      { begin: "\"", end: "\"" },
      { begin: "\, end: " },
      { begin: "R\"([^()\\ ]+)\\(", end: "\\)\\1\"|\\)\\"" }
    ]
  };
  return {
    name: "R",
    keywords: {
      $pattern: a,
      keyword: "function if in break next repeat else for while ... ..1 ..2 ..3 ..4 ..5 ..6 ..7 ..8 ..9",
      literal: "NULL NA TRUE FALSE Inf NaN NA_integer_|10 NA_real_|10 NA_character_|10 NA_complex_|10",
      built_in: "LETTERS letters month.abb month.name pi T F abs acos acosh all any anyNA Arg as.call as.character as.complex as.double as.environment as.integer as.logical as.null.default as.numeric as.raw asin asinh atan atanh attr attributes baseenv browser c call ceiling class Conj cos cosh cospi cummax cummin cumprod cumsum digamma dim dimnames emptyenv exp expression floor forceAndCall gamma gc.time globalenv Im interactive invisible is.array is.atomic is.call is.character is.complex is.double is.environment is.expression is.finite is.function is.infinite is.integer is.language is.list is.logical is.matrix is.na is.name is.nan is.null is.numeric is.object is.pairlist is.raw is.recursive is.single is.symbol lazyLoadDBfetch length lgamma list log max min missing Mod names nargs nzchar oldClass on.exit pos.to.env proc.time prod quote range Re rep retracemem return round seq_along seq_len seq.int sign signif sin sinh sinpi sqrt standardGeneric substitute sum switch tan tanh tanpi tracemem tracemem.default trunc unclass untracemem UseMethod warning xtfrm"
    },
    contains: [
      e.HASH_COMMENT_MODE,
      { begin: a, lexemes: a, keywords: { keyword: "function if in break next repeat else for while", literal: "NULL NA TRUE FALSE Inf NaN" }, relevance: 0 },
      { className: "number", begin: "0[xX][0-9a-fA-F]+[Li]?\\b", relevance: 0 },
      { className: "number", begin: "0[xX][0-9a-fA-F]+(?:[pP][+-]?[0-9]+)?[Li]?\\b", relevance: 0 },
      { className: "number", begin: "(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?[Li]?\\b", relevance: 0 },
      n
    ]
  };
};
