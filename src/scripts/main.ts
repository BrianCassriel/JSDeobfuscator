import { getSourceFile, setOutputFile } from "../utils";
import { Deobfuscator } from "./Deobfusctator";

console.log("Initializing deobfuscator...");

const sourceFile = getSourceFile() as string;
const outputFile = getSourceFile() as string;
setOutputFile(sourceFile);
new Deobfuscator(sourceFile, outputFile);