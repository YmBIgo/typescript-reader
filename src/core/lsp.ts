import fs from "fs/promises";
import { DocumentSymbol, SymbolInformation } from "vscode-languageclient/node";

export async function getFunctionContentFromLineAndCharacter(
  filePath: string,
  line: number,
  character: number
) {
  let originalFileContent: string = "";
  console.log(filePath, line, character);
  try {
    originalFileContent = await fs.readFile(filePath, "utf-8");
  } catch (e) {
    console.error(e);
    return "";
  }
  const fileContentSplit = originalFileContent.split("\n");
  const fileContentStart = fileContentSplit.slice(line);
  const failSafeFileContent = fileContentSplit
    .slice(line, line + 20)
    .join("\n");
  const [_, failSafeContent] = getFunctionDefinitionLines(failSafeFileContent);
  if (!failSafeContent.includes("{")) {
    return fileContentSplit.slice(line, line + 5).join("\n");
  }
  let fileResultArray = [];
  let startArrowCount = 0;
  let endArrowCount = 0;
  let isLongComment = false;
  const commentEndRegexp = /\s*\/\/.*$/g
  for (let row of fileContentStart) {
    fileResultArray.push(row);
    if (row.replace(/^\s+/g, "").startsWith("//")) {
      continue;
    }
    row = row.replace(commentEndRegexp, "");
    let commentStartIndex: number = -1;
    let commentEndIndex: number = -1;
    const longCommentStart = row.matchAll(/^("|'|`)\/\*/g);
    const longCommentEnd = row.matchAll(/^("|'|`)\*\//g);
    for (const start_m of longCommentStart) {
      commentStartIndex = start_m.index;
      // 最初で破棄
      break;
    }
    for (const end_m of longCommentEnd) {
      // 最後まで読む
      commentEndIndex = end_m.index;
    }
    if (
      commentStartIndex !== -1 &&
      commentEndIndex !== -1 &&
      commentStartIndex < commentEndIndex
    ) {
      // 1行のコメントなのでskip
    } else if (isLongComment && commentEndIndex !== -1) {
      // 一旦複雑なケースは考慮しない（コメントの中でのコメント定義など）
      isLongComment = false;
    } else if (!isLongComment && commentStartIndex !== -1) {
      isLongComment = true;
    }
    if (isLongComment) {
      continue;
    }
    startArrowCount += row.match(/\{\s*$/g)?.length ?? 0;
    endArrowCount += row.match(/^\s*\}/g)?.length ?? 0;
    if (
      startArrowCount === endArrowCount &&
      startArrowCount + endArrowCount !== 0
    ) {
      return fileResultArray.join("\n");
    }
  }
  console.error("error counting row...", startArrowCount, endArrowCount);
  return "";
}

//その行が関数定義かを判定
function getFunctionDefinitionLines(functionContent: string): [boolean, string] {
  const functionContentSplit = functionContent.split("\n");
  let startArrowCount = 0;
  let endArrowCount = 0;
  let isFunctionArrowExists = false;
  let resultFunctionContent = "";
  for(let functionContentRow of functionContentSplit) {
    resultFunctionContent += functionContentRow + "\n";
    startArrowCount += functionContentRow.split("").filter((t) => t === "(").length;
    endArrowCount += functionContentRow.split("").filter((t) => t === ")").length;
    if (functionContentRow.includes("{")) {
      isFunctionArrowExists = true;
    }
    if (functionContentRow.includes("}")) {
      break;
    }
  }
  if (startArrowCount === endArrowCount && isFunctionArrowExists) return [true, resultFunctionContent];
  return [false, resultFunctionContent]
}

export async function getFileLineAndCharacterFromFunctionName(
  filePath: string,
  codeLine: string,
  functionName: string,
  isFirst: boolean = false,
  secondCodeLine?: string
): Promise<[number, number]> {
  let fileContent: string = "";
  try {
    fileContent = await fs.readFile(filePath, "utf-8");
  } catch (e) {
    console.error(e);
    return [-1, -1];
  }
  const memberAccessFunction = isFirst ? functionName.split(")") : functionName.split(".");
  const memberAccessFunctionName = isFirst && memberAccessFunction.length > 2
    // func (mx *Mux) Mount(pattern string, handler http.Handler) { のように () で挟まっている場合
    ? memberAccessFunction[memberAccessFunction.length - 2]
    : memberAccessFunction[memberAccessFunction.length - 1];
  const functionFirstElement = memberAccessFunction[0]
  const isFirstDot = functionFirstElement.match(/^\s*$/g)
  const wholeFunctionName = memberAccessFunctionName;
  const simplfiedFunctionRegexp = !memberAccessFunctionName.includes("(") && memberAccessFunction.length === 1
    ? new RegExp(`${escapeRegExp(wholeFunctionName + "(")}`)
    : isFirst || memberAccessFunction.length > 1
    ? new RegExp(`${escapeRegExp(wholeFunctionName)}[^a-zA-Z0-9]*`)
    : new RegExp(`\\s*${escapeRegExp(wholeFunctionName)}[^a-zA-Z0-9]*`);
  const fileContentArray = fileContent.split("\n");
  let isLongComment = false;
  for (let i in fileContentArray) {
    const index = isNaN(Number(i)) ? -1 : Number(i);
    const row = fileContentArray[index];
    if (row.replace(/\s/g, "").startsWith("//")) {
      continue;
    }
    let commentStartIndex: number = -1;
    let commentEndIndex: number = -1;
    const longCommentStart = row.matchAll(/^("|'|`)\/\*/g);
    const longCommentEnd = row.matchAll(/^("|'|`)\*\//g);
    for (const start_m of longCommentStart) {
      commentStartIndex = start_m.index;
      // 最初で破棄
      break;
    }
    for (const end_m of longCommentEnd) {
      // 最後まで読む
      commentEndIndex = end_m.index;
    }
    if (
      commentStartIndex !== -1 &&
      commentEndIndex !== -1 &&
      commentStartIndex < commentEndIndex
    ) {
      // 1行のコメントなのでskip
    } else if (isLongComment && commentEndIndex !== -1) {
      // 一旦複雑なケースは考慮しない（コメントの中でのコメント定義など）
      isLongComment = false;
    } else if (!isLongComment && commentStartIndex !== -1) {
      isLongComment = true;
    }
    if (isLongComment) {
      continue;
    }
    if (!row.includes(functionName)) {
      continue;
    }
    if (!row.includes(codeLine)){
      continue;
    }
    if (secondCodeLine) {
      const nextRow = fileContentArray[index + 1];
      if (nextRow && !nextRow.includes(secondCodeLine)) {
        continue;
      }
    }
    let functionIndex = row.search(simplfiedFunctionRegexp);
    if (functionIndex >= 0) {
      functionIndex += 1;
    }
    if (isFirstDot) {
      functionIndex += 1;
    }
    if (functionIndex >= 0) {
      return [index, functionIndex];
    }
  }
  return [-1, -1];
}

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isSymbolInformation(
    v: DocumentSymbol | SymbolInformation
): v is SymbolInformation {
    return "location" in v && !("selectedRange" in v)
}

export function kindToString(kind: number): string {
  switch (kind) {
    case 1: return "File";
    case 2: return "Module";
    case 3: return "Namespace";
    case 4: return "Package";
    case 5: return "Class";
    case 6: return "Method";
    case 7: return "Property";
    case 8: return "Field";
    case 9: return "Constructor";
    case 10: return "Enum";
    case 11: return "Interface";
    case 12: return "Function";
    case 13: return "Variable";
    case 14: return "Constant";
    case 15: return "String";
    case 16: return "Number";
    case 17: return "Boolean";
    case 18: return "Array";
    case 19: return "Object";
    case 20: return "Key";
    case 21: return "Null";
    case 22: return "EnumMember";
    case 23: return "Struct";
    case 24: return "Event";
    case 25: return "Operator";
    case 26: return "TypeParameter";
    default: return `Unknown (${kind})`;
  }
}