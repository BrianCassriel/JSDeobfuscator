import { getOutputFile, getSourceFile } from "../utils";
import { Deobfuscator } from "./Deobfusctator";

console.log("Initializing deobfuscator...");

const sourceFile = getSourceFile() as string;
const outputFile = getOutputFile() as string;
new Deobfuscator(sourceFile, outputFile);