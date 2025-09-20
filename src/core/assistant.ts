import * as vscode from "vscode";
import * as vscodelc from "vscode-languageclient/node";
import fs from "fs/promises";

import {
  addFilePrefixToFilePath,
  pickFunctions,
  removeFilePrefixFromFilePath,
} from "./util/filepath";
import { ChoiceTree, HistoryHandler, ProcessChoice } from "./history";
import { LLMModel } from "./llm/model";
import { Message, MessageType } from "./type/Message";
import { Symbol } from "./type/Symbol";
import {
  getFileLineAndCharacterFromFunctionName,
  getFunctionContentFromLineAndCharacter,
  isSymbolInformation,
  kindToString,
} from "./lsp";
import { buildLLMHanlder, LLMName } from "./llm";
import Anthropic from "@anthropic-ai/sdk";
import { AskResponse } from "./type/Response";
import {
  bugFixPrompt,
  mermaidPrompt,
  pickCandidatePromopt,
  reportPromopt,
  searchFolderSystemPrompt,
  searchSymbolSystemPrompt,
} from "./prompt";
import pWaitFor from "p-wait-for";
import { is7wordString } from "./util/number";
import { DocumentSymbol, SymbolInformation } from "vscode-languageclient/node";

let client: TypeScriptLanguageClient | null;

class TypeScriptLanguageClient extends vscodelc.LanguageClient {
  // Override the default implementation for failed requests. The default
  // behavior is just to log failures in the output panel, however output panel
  // is designed for extension debugging purpose, normal users will not open it,
  // thus when the failure occurs, normal users doesn't know that.
  //
  // For user-interactive operations (e.g. applyFixIt, applyTweaks), we will
  // prompt up the failure to users.

  override handleFailedRequest<T>(
    type: vscodelc.MessageSignature,
    error: any,
    token: vscode.CancellationToken | undefined,
    defaultValue: T
  ): T {
    if (
      error instanceof vscodelc.ResponseError &&
      type.method === "workspace/executeCommand"
    ) {
      vscode.window.showErrorMessage(error.message);
    }
    return super.handleFailedRequest(type, token, error, defaultValue);
  }
}

export const typescriptLanguageServerDocumentSelector = [
  { scheme: "file", language: "typescript" },
  { scheme: "file", language: "typescriptreact"}
];

export class TypeScriptReader {
  private apiHandler: LLMModel | null;
  private historyHanlder: HistoryHandler | null = null;
  private rootPath: string = "";
  private rootLine: number = -1;
  private rootCharacter: number = -1;
  private rootFunctionName: string = "";
  private purpose: string = "";

  private saySocket: (content: string) => void;
  private sendErrorSocket: (content: string) => void;
  private askSocket: (content: string) => Promise<AskResponse>;
  private mermaidSocket: (content: string) => void;
  private sendState: (messages: Message[]) => void;

  messages: Message[] = [];
  private askResponse?: string;
  private saveReportFolder: string;

  constructor(
    ask: (content: string) => Promise<AskResponse>,
    say: (content: string) => void,
    sendError: (content: string) => void,
    sendState: (messages: Message[]) => void,
    llmName: LLMName,
    // openai
    openAIModel: string,
    openAIApiKey: string,
    // anthropic
    anthropicModel: string,
    anthropicApiKey: string,
    // plamo
    plamoApiKey: string,
    // gemini
    geminiModel: string,
    geminiApiKey: string,
    // tsLanguageServer
    tsLanguageServerPath: string,
    tsProjectPath: string,
    reportPath: string
  ) {
    this.saySocket = (content: string) => {
      const m = this.addMessages(content, "say");
      sendState(m);
      say(content);
    };
    this.askSocket = (content: string) => {
      const m = this.addMessages(content, "ask");
      sendState(m);
      return ask(content);
    };
    this.sendErrorSocket = (content: string) => {
      const m = this.addMessages(content, "error");
      sendState(m);
      sendError(content);
    };
    this.mermaidSocket = (content: string) => {
      const m = this.addMessages(content, "mermaid");
      sendState(m);
    };
    this.sendState = sendState;
    const modelType =
      llmName === "openai"
        ? openAIModel
        : llmName === "anthropic"
          ? anthropicModel
          : llmName === "gemini"
            ? geminiModel
            : "";
    const apiKey =
      llmName === "openai"
        ? openAIApiKey
        : llmName === "anthropic"
          ? anthropicApiKey
          : llmName === "plamo"
            ? plamoApiKey
            : llmName === "gemini"
              ? geminiApiKey
              : "unknown llm name";
    this.apiHandler = buildLLMHanlder(llmName, modelType, apiKey);
    this.saveReportFolder = reportPath;
    if (!tsLanguageServerPath || !tsProjectPath) {
      return;
    }
    this.init(tsLanguageServerPath, tsProjectPath);
  }

  private async init(
    tsLanguageServerPath: string,
    tsProjectPath: string,
  ) {
    console.log("connecting to ts language server @", tsLanguageServerPath)
    const tsLanguageServer: vscodelc.Executable = {
      command: tsLanguageServerPath,
      args: ["--stdio"],
      options: {
        cwd: tsProjectPath,
        shell: false,
        env: process.env
      },
    };
    const serverOptions: vscodelc.ServerOptions = tsLanguageServer;
    const clientOptions: vscodelc.LanguageClientOptions = {
      documentSelector: typescriptLanguageServerDocumentSelector,
      initializationOptions: {
      },
      revealOutputChannelOn: vscodelc.RevealOutputChannelOn.Never,
    };
    if (client) {
      await client
        ?.restart()
        .then(() => {
          console.log("client restarting");
        })
        .catch(() => {
          console.error("client failed to restart...");
        });
    } else {
      client = new TypeScriptLanguageClient(
        `TypeScript Reader`,
        serverOptions,
        clientOptions
      );
      await client
        ?.start()
        .then(() => {
          console.log("client starting");
        })
        .catch(() => {
          console.error("client failed to start...");
        });
    }
    console.log("init finished! with status", client.state);
  }

  async runFirstTaskWithFolder(
    searchFolderPath: string,
    purpose: string
  ) {
    this.saySocket("This operation usually takes 2 ~ 5minutes");
    const pickResults = await pickFunctions(searchFolderPath);
    const flattenPickResults = pickResults
    .reduce((a, b) => {
      a.push(b[2])
        return a
    }, [] as string[][])
    const filteredPickResults = flattenPickResults
      .map((r) => {
        if (!r) return null
        return r.map((rc) => rc.replace(searchFolderPath, ""));
    })
    .filter(Boolean)
    .join("\n");
    const searchFolderPrompt = `[purpose]
${purpose}. And want to find the entrypoint.
[filePaths]
${filteredPickResults}
`;
    const history: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: searchFolderPrompt },
    ];
    let responseJSON: any;
    try {
      const response =
        (await this.apiHandler?.createMessage(
          searchFolderSystemPrompt,
          history,
          false
        )) ?? "{}";
      responseJSON = JSON.parse(response);
    } catch (e) {
      console.error(e);
      this.sendErrorSocket(`API Error`);
      return;
    }
    if (!Array.isArray(responseJSON)) {
      console.error("respond JSON format is not Array...");
      this.sendErrorSocket(`Returned information is wrong...`);
      return;
    }
    this.saySocket("Glob done. Next : Search Files.")
    let folderFileNameResult: Symbol[] = [];
    for (let j of responseJSON) {
      const symbolResult = await this.symbolTsLanguageServer(searchFolderPath + j);
      if (!symbolResult || !symbolResult.length) continue;
      folderFileNameResult = [...folderFileNameResult, ...symbolResult]
    }
    folderFileNameResult = folderFileNameResult.map((f, index) => {
      return {...f, id: index}
    });
    const filteredPickFunctions = folderFileNameResult.map((f) => {
      return `id: ${f.id} / name: ${f.name} / kind: ${f.kind} / path: ${f.path.replace(searchFolderPath, "")} / parent: ${f.parent}`
    }).join("\n");
    const searchFilePrompt = `[purpose]
${purpose}. And want to find the entrypoint.
[functions]
${filteredPickFunctions}
`
    const history2: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: searchFilePrompt },
    ];
    let responseJSON2: any;
    try {
      const response =
        (await this.apiHandler?.createMessage(
          searchSymbolSystemPrompt,
          history2,
          false
        )) ?? "{}";
      responseJSON2 = JSON.parse(response);
    } catch (e) {
      console.error(e);
      this.sendErrorSocket(`API Error`);
      return;
    }
    if (!Array.isArray(responseJSON2)) {
      console.error("respond JSON format is not Array...");
      this.sendErrorSocket(`Returned information is wrong...`);
      return;
    }
    console.log(JSON.stringify(responseJSON2));
    const openAIResultIds = responseJSON2.map((r: any) => r.id);
    const finalSymbolResult = folderFileNameResult.filter((s) => {
      return openAIResultIds.includes(s.id);
    });
    console.log(JSON.stringify(finalSymbolResult));
    let askQuestion = "";
    finalSymbolResult.forEach((f, index) => {
      askQuestion += `${index} : ${f.name}\n`;
      askQuestion += `Kind : ${f.kind}\n`;
      askQuestion += `Path : ${f.path}\n`;
      askQuestion += `Content : ${f.content}\n`
      askQuestion += `----------------------------\n`;
    });
    let resultNumber = 0;
    let result: AskResponse | null = null;
    this.saySocket(`${askQuestion}`);
    for (; ;) {
      result = await this.askSocket(`Please enter index you want to search.`);
      console.log(`result : ${result.ask}`);
      resultNumber = Number(result.ask);
      const newMessages = this.addMessages(`User Enter ${result.ask}`, "user");
      this.sendState(newMessages);
      if (!isNaN(resultNumber) && resultNumber < finalSymbolResult.length) {
        break;
      }
      this.saySocket("Please input correct index");
    }
    const searchSymbolResult = finalSymbolResult[resultNumber];
    if (!searchSymbolResult) {
      console.error("Please input correct index");
      this.sendErrorSocket("Please input correct index");
      return;
    }
    this.runFirstTask(searchSymbolResult.path, searchSymbolResult.content, purpose);
  }

  async runFirstTaskWithHistory(
    currentFilePath: string,
    currentFunctionName: string,
    purpose: string,
    choiceTree: ChoiceTree
  ) {
    this.rootPath = currentFilePath;
    this.rootFunctionName = currentFunctionName;
    const [currentLine, currentCharacter] =
      await getFileLineAndCharacterFromFunctionName(
        currentFilePath,
        currentFunctionName,
        currentFunctionName,
        true,
      );
    if (currentLine === -1 && currentCharacter === -1) {
      this.sendErrorSocket(
        `Can not find content below. ${currentFunctionName} @ ${currentFilePath}...`
      );
    }
    const functionCodeContent = await getFunctionContentFromLineAndCharacter(currentFilePath, currentLine, currentCharacter);
    this.rootLine = currentLine;
    this.rootCharacter = currentCharacter;
    this.purpose = purpose;
    this.historyHanlder = new HistoryHandler(
      this.rootPath,
      currentFunctionName,
      currentFunctionName,
      functionCodeContent,
    );
    this.historyHanlder.overWriteChoiceTree(choiceTree);
    const historyTree = this.historyHanlder.showHistory();
    if (historyTree) {
      this.saySocket(historyTree);
    }
    const question = "Input hash value of past history which you want to search from.";
    const result = await this.askSocket(question);
    if (is7wordString(result.ask)) {
      await this.runIntercativeHistoryPoint(result.ask);
      return;
    }
    this.sendErrorSocket("Can not find hash value. Please try again.");
  }

  async runFirstTask(
    currentFilePath: string,
    currentFunctionName: string,
    purpose: string
  ) {
    this.rootPath = currentFilePath;
    this.rootFunctionName = currentFunctionName;
    const [currentLine, currentCharacter] =
      await getFileLineAndCharacterFromFunctionName(
        currentFilePath,
        currentFunctionName,
        currentFunctionName,
        true,
      );
    if (currentLine === -1 && currentCharacter === -1) {
      this.sendErrorSocket(
        `Can not find content of ${currentFunctionName} @ ${currentFilePath}...`
      );
    }
    const functionCodeContent = await getFunctionContentFromLineAndCharacter(
      currentFilePath,
      currentLine,
      currentCharacter
    );
    this.jumpToCode(currentFilePath, functionCodeContent);
    this.rootLine = currentLine;
    this.rootCharacter = currentCharacter;
    this.purpose = purpose;
    this.historyHanlder = new HistoryHandler(
      this.rootPath,
      currentFunctionName,
      currentFunctionName,
      functionCodeContent,
    );
    this.runInitialTask(this.rootPath, this.rootLine, this.rootCharacter);
  }

  private async runInitialTask(
    currentFilePath: string,
    currentLine: number,
    currentCharacter: number
  ) {
    let functionContent: string = "";
    try {
      functionContent = await getFunctionContentFromLineAndCharacter(
        currentFilePath,
        currentLine,
        currentCharacter
      );
    } catch (e) {
      console.error(e);
      this.sendErrorSocket(
        `Can not find content of ${currentFilePath}@${currentLine}:${currentCharacter}`
      );
      return;
    }
    this.runTask(currentFilePath, functionContent);
  }
  private async runTask(currentFilePath: string, functionContent: string) {
    const userPrompt = `
\`\`\`purpose
${this.purpose}
\`\`\`

\`\`\`code
${functionContent}
\`\`\``;
    console.log(userPrompt);
    const history: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: userPrompt },
    ];
    let responseJSON: any;
    try {
      const response =
        (await this.apiHandler?.createMessage(
          pickCandidatePromopt,
          history,
          true
        )) ?? "{}";
      responseJSON = JSON.parse(response);
    } catch (e) {
      console.error(e);
      this.sendErrorSocket(`API Error`);
      this.saveChoiceTree();
      return;
    }
    if (!Array.isArray(responseJSON)) {
      console.error("respond JSON format is not Array...");
      this.sendErrorSocket(`Returned information is wrong...`);
      this.saveChoiceTree();
      return;
    }
    // TODO : 正確な型をつける
    const fileContentArray = functionContent.split("\n");
    let newHistoryChoices: ProcessChoice[] = [];
    let parsedContentCodeLineArray: string[] = [];
    let askQuestion = "";
    console.log(JSON.stringify(responseJSON));
    responseJSON.forEach((each_r, index) => {
      let isLongComment = false;
      let isLongComment2 = false;
      const fileCodeLine =
        fileContentArray.find((fcr) => {
          if (!fcr) return false
          if (fcr.includes(each_r.code_line)) {
            return true;
          }
          return false;
        }) ??
          fileContentArray.find((fcr) => {
            const spaceRemovedRow = fcr.replace(/ /g, "").replace(/\t/g, "");
            let commentStartIndex: number = -1;
            let commentEndIndex: number = -1;
            const longCommentStart = spaceRemovedRow.matchAll(/\/\*/g);
            const longCommentEnd = spaceRemovedRow.matchAll(/\*\//g);
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
              return;
            }
            if (spaceRemovedRow.startsWith("//")) {
              return;
            }
          }) ??
          each_r.code_line.includes(each_r["name"])
          ? each_r.code_line
          : fileContentArray.find((fcr) => {
            const spaceRemovedRow = fcr.replace(/ /g, "").replace(/\t/g, "");
            if (spaceRemovedRow.startsWith("//")) {
              return false;
            }
            let commentStartIndex: number = -1;
            let commentEndIndex: number = -1;
            const longCommentStart = spaceRemovedRow.matchAll(/\/\*/g);
            const longCommentEnd = spaceRemovedRow.matchAll(/\*\//g);
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
            } else if (isLongComment2 && commentEndIndex !== -1) {
              // 一旦複雑なケースは考慮しない（コメントの中でのコメント定義など）
              isLongComment2 = false;
            } else if (!isLongComment && commentStartIndex !== -1) {
              isLongComment2 = true;
            }
            if (isLongComment2) {
              return false;
            }
            return fcr.includes(each_r["name"]);
          }) ?? each_r["name"];
      parsedContentCodeLineArray.push(fileCodeLine);
      askQuestion += `${index} : ${each_r.name}\n`;
      askQuestion += `Details : ${each_r.description}\n`;
      askQuestion += `Whole Code Line : ${fileCodeLine}\n`;
      askQuestion += `Original Code : ${each_r.code_line}\n`;
      askQuestion += `Confidence : ${each_r.score}\n`;
      askQuestion += `----------------------------\n`;
      newHistoryChoices.push({
        functionName: each_r.name,
        functionCodeLine: fileCodeLine,
        originalFilePath: currentFilePath,
      });
    });
    let resultNumber = 0;
    let result: AskResponse | null = null;
    this.saySocket(`${askQuestion}`);
    for (; ;) {
      result = await this.askSocket(`Please enter the index you want to display:
- Enter 5 to retry
- Enter 6 to display the history as a tree structure
- Enter 7 to generate an exploration report
- Enter 8 to display the current file
- Enter 9 to generate a Mermaid diagram of the current function
- Enter 10 to detect potential bugs
- Enter 11 to save the history so far as JSON
※ If you enter a string, it will be interpreted as a hash value to search the past history.`);
      console.log(`result : ${result.ask}`);
      resultNumber = Number(result.ask);
      const newMessages = this.addMessages(`User Enter ${result.ask}`, "user");
      this.sendState(newMessages);
      if (isNaN(resultNumber) || is7wordString(result.ask)) {
        // this.runHistoryPoint(result.ask);
        break;
      }
      if (resultNumber >= 0 && resultNumber < 5) {
        break;
      }
      if (resultNumber === 5) {
        // this.runTask(currentPath, functionContent);
        break;
      }
      if (resultNumber === 6) {
        const historyTree = this.historyHanlder?.showHistory();
        if (historyTree) {
          this.saySocket(historyTree);
        }
        continue;
      }
      if (resultNumber === 7) {
        await this.getReport();
        continue;
      }
      if (resultNumber === 8) {
        this.jumpToCode(currentFilePath, functionContent)
        continue;
      } else if (resultNumber === 9) {
        await this.getMermaid(functionContent);
        continue;
      } else if (resultNumber === 10) {
        await this.getBugsReport();
        continue;
      } else if (resultNumber === 11) {
        this.saveChoiceTree();
        continue;
      }
    }
    if (is7wordString(result.ask)) {
      await this.runHistoryPoint(result.ask);
      return;
    }
    if (resultNumber === 5) {
      this.runTask(currentFilePath, functionContent);
      return;
    }
    if (!responseJSON[resultNumber]) {
      this.sendErrorSocket(
        `Your choice "${resultNumber}" is not valid choice`
      );
      return;
    }
    this.saySocket(
      `TsLanguageServer is searching "${responseJSON[resultNumber].name}"`
    );
    let [searchLine, searchCharacter] =
      await getFileLineAndCharacterFromFunctionName(
        currentFilePath,
        responseJSON[resultNumber].code_line,
        responseJSON[resultNumber].name,
        false
      );
    if (searchLine === -1 && searchCharacter === -1) {
      this.sendErrorSocket(`Failed while searching files.`);
      this.saveChoiceTree();
      return;
    }
    const [newFile, newLine, newCharacter, newFunctionContent] =
      await this.queryTsLanguageServer(currentFilePath, searchLine, searchCharacter);
    if (!newFile) {
      console.error("TsLanguageServer fails to search file.");
      this.sendErrorSocket("TsLanguageServer fails to search file.");
      this.saveChoiceTree();
      return;
    }
    newHistoryChoices = newHistoryChoices.map((hc, index) => {
      if (String(index) === result.ask) {
        const newHc = hc;
        newHc.originalFilePath = removeFilePrefixFromFilePath(newFile);
        return newHc;
      } 
      return hc
    });
    const comment = await this.askSocket("If you have any comments write it down.\nIf you have no comment please just write 'no comment'.");
    const newMessages = this.addMessages(`User Enter ${comment.ask}`, "user");
    this.sendState(newMessages);
    this.historyHanlder?.addHistory(newHistoryChoices);
    this.jumpToCode(removeFilePrefixFromFilePath(newFile), newFunctionContent);
    this.historyHanlder?.choose(resultNumber, newFunctionContent, comment.ask);
    this.saySocket(
      `LLM is searching ${newFile}@${newLine}:${newCharacter}.`
    );
    this.runTask(removeFilePrefixFromFilePath(newFile), newFunctionContent);
  }

  private async jumpToCode(currentFilePath: string, functionContent: string) {
    try {
      const openDoc = await vscode.workspace.openTextDocument(
        currentFilePath
      );
      await vscode.window.showTextDocument(openDoc, {
        preview: false, // タブの使い回しを避ける場合は false
        preserveFocus: false, // エディタにフォーカスを移す
      });
      const openDocText = openDoc.getText().split("\n");
      const functionLines = functionContent.split("\n").filter((fcr) => {
        return fcr.replace(/\s\t/g, "") !== "";
      });
      let functionStartLine = functionLines[0];
      let functionEndLine = functionLines.at(-1);
      console.log("jump to", functionStartLine, functionEndLine)
      const functionStartLineIndex =
        openDocText.findIndex((odt) => odt === functionStartLine) ?? 0;
      const positionStart = new vscode.Position(functionStartLineIndex, 0);
      const positionEnd = new vscode.Position(
        functionStartLineIndex + functionContent.split("\n").length,
        functionEndLine?.length ?? 10000
      );
      const selection = new vscode.Selection(positionStart, positionEnd);
      vscode.window.activeTextEditor!.selection = selection;
      vscode.window.activeTextEditor?.revealRange(
        new vscode.Range(positionStart, positionEnd),
        vscode.TextEditorRevealType.AtTop
      )
      // this.saySocket("\n\n----------\n" + functionContent + "\n----------\n\n");
    } catch (e) {
      console.warn(e);
    }
  }

  private async runIntercativeHistoryPoint(historyHash: string) {
    const searchResult = this.historyHanlder?.searchTreeByIdPublic(historyHash);
    if (!searchResult) {
      this.sendErrorSocket(
        `Can not find hash value of selected search history. ${historyHash}`
      );
      this.saveChoiceTree();
      return;
    }
    for (let i = 0; i < searchResult.pos.length; i++) {
      const pos = searchResult.pos.slice(0, i + 1);
      const currentRunConfig = this.historyHanlder?.getContentFromPos(pos);
      if (!currentRunConfig) {
        this.saySocket(`Can not find content positioned at ${pos.length} ${pos[pos.length - 1].depth}:${pos[pos.length - 1].width}`);
        continue;
      }
      const { functionCodeContent, functionCodeLine, functionName, originalFilePath, id } = currentRunConfig;
      let functionResult = functionCodeContent;
      if (!functionCodeContent) {
        const [line, character] = await getFileLineAndCharacterFromFunctionName(originalFilePath, functionCodeLine, functionName);
        if (line === -1 && character === -1) {
          this.sendErrorSocket(
            `Can not find function of selected search history. ${historyHash}`
          );
          this.saveChoiceTree();
          return;
        }
        const [newFile, , , newFileContent] = await this.queryTsLanguageServer(originalFilePath, line, character);
        if (!newFile) {
          console.error("TsLanguageServer fails to search file");
          this.sendErrorSocket("TsLanguageServer fails to search file");
          this.saveChoiceTree();
          return;
        }
        functionResult = newFileContent;
      }
      const foundCallback = (st: ChoiceTree) => {
        st.content.functionCodeContent = functionResult ?? functionCodeLine;
      }
      this.historyHanlder?.moveById(id.slice(0, 7), foundCallback);
      if (searchResult.pos.length === i + 1) {
        break;
      }
      if (functionResult) {
        this.saySocket("Jump to the selected code ...")
        this.jumpToCode(originalFilePath, functionResult);
      }
      let resultString = ""
      for(;;) {
        const result = await this.askSocket("Please Enter 1 when you want to jump to the next function.");
        if (parseInt(result.ask) === 1) {
          resultString = "1"
          break;
        }
      }
      const newMessages = this.addMessages(`User Enter ${resultString}`, "user");
      this.sendState(newMessages);
    }
    this.runHistoryPoint(historyHash);
  }

  private async runHistoryPoint(historyHash: string) {
    const newRunConfig = this.historyHanlder?.moveById(historyHash);
    if (!newRunConfig) {
      this.sendErrorSocket(
        `Can not find hash value of selected search history. ${historyHash}`
      );
      this.saveChoiceTree();
      return;
    }
    const { functionCodeContent, functionCodeLine, functionName, originalFilePath } = newRunConfig;
    let functionResult = functionCodeContent;
    if (!functionCodeContent) {
      const [line, character] = await getFileLineAndCharacterFromFunctionName(originalFilePath, functionCodeLine, functionName);
      if (line === -1 && character === -1) {
        this.sendErrorSocket(
          `Can not find function of selected search history. ${historyHash}`
        );
        this.saveChoiceTree();
        return;
      }
      const [newFile, , , newFileContent] = await this.queryTsLanguageServer(originalFilePath, line, character);
      if (!newFile) {
        console.error("TsLanguageServer fails to search file");
        this.sendErrorSocket("TsLanguageServer fails to search file");
        this.saveChoiceTree();
        return;
      }
      functionResult = newFileContent;
    }
    const foundCallback = (st: ChoiceTree) => {
      st.content.functionCodeContent = functionResult ?? functionCodeLine;
    }
    this.historyHanlder?.moveById(historyHash, foundCallback);
    if (functionResult) this.jumpToCode(originalFilePath, functionResult)
    this.runTask(originalFilePath, functionResult ?? functionCodeLine);
  }

  private async getReport() {
    const r = this.historyHanlder?.traceFunctionContent();
    if (!r) {
      this.sendErrorSocket(`Fail to get report.`);
      return;
    }
    const [result, functionResult] = r;
    this.saySocket(`Generate Report related to "${functionResult}"`);
    const userPrompt = `\`\`\`purpose
${this.purpose}
\`\`\`

${result}`;
    const history: Anthropic.MessageParam[] = [
      { role: "user", content: userPrompt },
    ];
    const response =
      (await this.apiHandler?.createMessage(
        reportPromopt,
        history,
        false
      )) || "failed to get result";
    const res = response + "\n\n - Details \n\n" + result;
    const fileName = `report_${Date.now()}.txt`;
    await fs.writeFile(`${this.saveReportFolder}/${fileName}`, res);
    this.saySocket(
      `Generate Report successfully @${this.saveReportFolder}/${fileName}`
    );
  }

  private async getMermaid(functionContent: string) {
    this.saySocket(`Start generating Mermaid diagram of the current function.`);
    const userPrompt = `\`\`\`content
${functionContent}
\`\`\``;
    const history: Anthropic.MessageParam[] = [
      { role: "user", content: userPrompt },
    ];
    const response =
      (await this.apiHandler?.createMessage(mermaidPrompt, history, false)) ||
      "failed to get result";
    this.saySocket(`Generate Mermaid diagram. Done!`);
    this.mermaidSocket(response);
  }
  private async getBugsReport() {
    const description = await this.askSocket(
      `Write any thought about potential bugs.（If you don't have ideas just enter "no"）`
    );
    const r = this.historyHanlder?.traceFunctionContent();
    if (!r) {
      this.sendErrorSocket(`Fail to get Bug Report.`);
      return;
    }
    const [result, functionResult] = r;
    this.saySocket(`Searching bugs related to "${functionResult}"`);
    const userPrompt = `<functions or methods>
${result}
<the potential bugs (optional)>
${description.ask ? description.ask : "not provided..."}
`;
    const history: Anthropic.MessageParam[] = [
      { role: "user", content: userPrompt },
    ];
    const response =
      (await this.apiHandler?.createMessage(bugFixPrompt, history, false, true)) ||
      "failed to get result";
    const fileName = `bugreport_${Date.now()}.txt`;
    await fs.writeFile(`${this.saveReportFolder}/${fileName}`, response + "\n\n" + result);
    this.saySocket(response);
    this.saySocket(`Generate Bugs Report Done! File is created @${this.saveReportFolder}/${fileName}`);
  }
  private async saveChoiceTree() {
    const choiceTreeWithAdditionalInfo = {
      ...this.historyHanlder?.getChoiceTree(),
      purpose: this.purpose,
      rootPath: this.rootPath,
      rootFunctionName: this.rootFunctionName
    };
    const choiceTreeString = JSON.stringify(choiceTreeWithAdditionalInfo);
    if (!choiceTreeString) {
      return;
    }
    const fileName = `choices_${Date.now()}.json`;
    await fs.writeFile(
      `${this.saveReportFolder}/${fileName}`,
      choiceTreeString
    );
    this.saySocket(
      `Search history related to "${this.saveReportFolder}/${fileName}" is saved to your local path.`
    );
  }

  private async doQueryTsLanguageServer(
    filePath: string,
    line: number,
    character: number,
    shouldWaitMs: number = 2000,
    requestType: string = "textDocument/definition"
  ): Promise<[string, number, number, any]> {
    console.log(line, character);
    let itemString: string = "";
    const fileContent = await fs.readFile(filePath, "utf-8");
    await pWaitFor(() => !!this.isTsLanguageServerRunning(), {
      interval: 500,
    });
    await client?.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: addFilePrefixToFilePath(filePath),
        languageId: "typescript",
        version: 0,
        text: fileContent,
      },
    });
    if (shouldWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, shouldWaitMs));
    }
    await client
      ?.sendRequest(requestType, {
        textDocument: {
          uri: addFilePrefixToFilePath(filePath),
        },
        position: { line, character },
      })
      .then((result) => {
        console.log(requestType, "result : ", result)
        itemString = JSON.stringify(result);
      });
    let item: any = [];
    try {
      item = JSON.parse(itemString as any);
    } catch (e) {
      console.error(e);
      this.saveChoiceTree();
    }
    if (!Array.isArray(item) || item.length <= 0) {
      console.log("item not array", item);
      return ["", 0, 0, item];
    }
    const firstItem = (requestType.includes("implementation") && item.length > 1) ? item[1] : item[0];
    const file = firstItem.uri ?? firstItem.targetUri;
    await client?.sendNotification("textDocument/didClose", {
      textDocument: {
        uri: addFilePrefixToFilePath(filePath),
        languageId: "typescript",
        version: 0,
        text: fileContent,
      },
    });
    const startLine = firstItem.range ? firstItem.range.start.line : firstItem.targetRange.start.line;
    const startCharacter = firstItem.range ? firstItem.range.start.character : firstItem.targetRange.start.character;
    return [
      file,
      startLine,
      startCharacter,
      item,
    ];
  }

  async queryTsLanguageServer(
    filePath: string,
    line: number,
    character: number
  ): Promise<[string, number, number, string, any]> {
    const [newFilePath1, newLine1, newCharacter1, item1] =
      await this.doQueryTsLanguageServer(filePath, line, character, 5000);
    let newFilePath2 = newFilePath1;
    let newLine2 = newLine1;
    let newCharacter2 = newCharacter1;
    let item2 = item1;

    let functionContent = await getFunctionContentFromLineAndCharacter(
      removeFilePrefixFromFilePath(newFilePath2),
      newLine2,
      newCharacter2
    );
    const shouldQueryImplementation = (!functionContent.includes("{") && !functionContent.includes("}")) || functionContent.indexOf("}") - functionContent.indexOf("{") < 3
    if (shouldQueryImplementation && functionContent.split("\n").length < 6) {
      const [newFilePath3, newLine3, newCharacter3, item3] = await this.doQueryTsLanguageServer(removeFilePrefixFromFilePath(newFilePath2), newLine2, newCharacter2, 5000, "textDocument/implementation")
      newFilePath2 = newFilePath3
      newLine2 = newLine3
      newCharacter2 = newCharacter3
      item2 = item3
      functionContent = await getFunctionContentFromLineAndCharacter(
        removeFilePrefixFromFilePath(newFilePath3),
        newLine3,
        newCharacter3
      )
    }
    return [newFilePath2, newLine2, newCharacter2, functionContent, item2];
  }

  async doSymbolTsLanguageServer(
    filePath: string
  ): Promise<{result: any; content: string}> {
    const fileContent = await fs.readFile(filePath, "utf-8");
    await pWaitFor(() => !!this.isTsLanguageServerRunning(), {
      interval: 500,
    });
    await client?.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: addFilePrefixToFilePath(filePath),
        languageId: "java",
        version: 0,
        text: fileContent,
      },
    });
    let itemString: string = "";
    await client?.sendRequest(
      "textDocument/documentSymbol",
      {
        textDocument: {
          uri: addFilePrefixToFilePath(filePath),
        },
      }
    )
    .then((result) => {
      itemString = JSON.stringify(result);
    });
    let item: any = [];
    try {
      item = JSON.parse(itemString as any);
    } catch (e) {
      console.error(e);
      this.saveChoiceTree();
    }
    if (!Array.isArray(item) || !item.length) {
      return {result: [], content: fileContent}
    }
    await client?.sendNotification("textDocument/didClose", {
      textDocument: {
        uri: addFilePrefixToFilePath(filePath),
        languageId: "java",
        version: 0,
        text: fileContent,
      },
    });
    return {result: item, content: fileContent}
  }

  async symbolTsLanguageServer(filePath: string): Promise<Symbol[]> {
    const {result, content} = await this.doSymbolTsLanguageServer(filePath);
    if (!result || !content) return [];
    const fileNameArray = filePath.split("/")
    const splitContent = content.split("\n");
    let childrenOpenedResult: Array<SymbolInformation | DocumentSymbol> = result
    function openChildren(children: Array<SymbolInformation | DocumentSymbol> ) {
      childrenOpenedResult = [...childrenOpenedResult, ...children];
      children.forEach((c) => {
        if (!isSymbolInformation(c) && c.children) openChildren(c.children); 
      })
    }
    result.forEach((r: SymbolInformation | DocumentSymbol) => {
      if (!isSymbolInformation(r) && r.children) openChildren(r.children); 
    })
    const filtered_result = childrenOpenedResult?.filter((r: any) => {
      if (typeof r !== "object" || !r.kind) return false;
      if (r.kind === 6 || r.kind === 12 || r.kind === 11 || r.kind === 9) return true;
      return false
    }).map((f: any) => {
      if (isSymbolInformation(f)) {
        const startLine = f.location.range.start.line;
        const content = splitContent[startLine] || "";
        const kind = kindToString(f.kind);
        return {
          name: f.name,
          content,
          kind,
          range: f.location.range,
          parent: f.containerName ?? "",
          path: filePath
        }
      }
      const startLine = f.selectionRange.start.line;
      const content = splitContent[startLine] || "";
      const kind = kindToString(f.kind);
      const parent = fileNameArray[fileNameArray.length - 1] ?? "";
      return {
        name: f.name,
        content,
        kind,
        range: f.selectionRange,
        parent,
        path: filePath
      };
    });
    return filtered_result;
  }

  private isTsLanguageServerRunning() {
    return client?.state === vscodelc.State.Running;
  }

  async doGC() {
    this.rootPath = "";
    this.rootLine = -1;
    this.rootCharacter = -1;
    this.saySocket = () => { };
    this.askSocket = async (content: string) => {
      return {} as AskResponse;
    };
    this.messages = [];
    this.sendState = () => { };
    this.historyHanlder = null;
    this.apiHandler = buildLLMHanlder("openai", "gpt-5", "no key");
  }

  handleWebViewAskResponse(askResponse: string) {
    this.askResponse = askResponse;
  }
  getWebViewAskResponse(): string | undefined {
    return this.askResponse;
  }
  clearWebViewAskResponse() {
    this.askResponse = undefined;
  }
  getMessages() {
    return this.messages;
  }
  addMessages(content: string, type: MessageType) {
    this.messages.push({ type, content, time: Date.now() });
    return this.messages;
  }
  setMessages(messages: Message[]) {
    this.messages = messages;
  }
}
