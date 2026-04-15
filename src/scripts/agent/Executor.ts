import { getOutputFile, setOutputFile } from "../../utils";
import type { AgentResponse, AgentOperation } from "./Editor";
import { AstTools } from "./tools/AstTools";

export class Executor {
    static previousContent: string = "";

    static execute(result: AgentResponse) {
        let code = getOutputFile() ?? "";
        this.previousContent = code;

        for (const op of result.operations) {
            code = this.applyOperation(code, op);
        }

        setOutputFile(code);
    }

    static applyOperation(code: string, op: AgentOperation): string {
        switch (op.tool) {
            case 'rename_identifier':
                if (op.oldName && op.newName)
                    return AstTools.renameIdentifier(code, op.oldName, op.newName);
                return code;
            case 'replace_block':
                if (op.search && op.replace !== null)
                    return AstTools.replaceBlock(code, op.search, op.replace);
                return code;
            case 'replace_all':
                if (op.search && op.replace !== null)
                    return AstTools.replaceAll(code, op.search, op.replace);
                return code;
            case 'rewrite_function':
                if (op.functionName && op.functionCode)
                    return AstTools.rewriteFunction(code, op.functionName, op.functionCode);
                return code;
            case 'insert_comment':
                if (op.line && op.comment)
                    return AstTools.insertComment(code, op.line, op.comment);
                return code;
            default:
                return code;
        }
    }

    static revert() {
        setOutputFile(this.previousContent);
    }
}