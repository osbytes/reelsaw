// ts-reset: JSON.parse, .json() and Array.isArray give unknown, not any, so data from outside must be parsed
// (docs/PRINCIPLES.md, "No type ascriptions"); .filter(Boolean) narrows.
import "@total-typescript/ts-reset";
