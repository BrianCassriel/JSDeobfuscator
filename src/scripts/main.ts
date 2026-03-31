import { getSourceFile } from "../utils";
import { Deobfuscator } from "./Deobfusctator";

console.log("Initializing deobfuscator...");

const sourceFile = getSourceFile() as string;
const outputFile = getSourceFile() as string;
new Deobfuscator(sourceFile, outputFile);