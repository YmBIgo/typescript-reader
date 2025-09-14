// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { TypeScriptLLMReaderProvider } from './core/provider';

let outputChannel: vscode.OutputChannel;
let tabProvider: TypeScriptLLMReaderProvider;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "typescript-reader" is now active!');

	outputChannel = vscode.window.createOutputChannel("typescript-reader");
	context.subscriptions.push(outputChannel);

	tabProvider = new TypeScriptLLMReaderProvider(context);

	const openTypeScriptReaderInNewTab = () => {
		const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0));
		const targetCol = Math.max(lastCol + 1, 1);
		const panel = vscode.window.createWebviewPanel(TypeScriptLLMReaderProvider.viewType, "typescript-reader", targetCol, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [context.extensionUri],
		});
		tabProvider.resolveWebviewView(panel);

		// Lock the editor group so clicking on files doesn't open them over the panel
		new Promise((resolve) => setTimeout(resolve, 100)).then(() => {
			vscode.commands.executeCommand("workbench.action.lockEditorGroup");
		});
	};

	context.subscriptions.push(vscode.commands.registerCommand("typescript-reader.openInNewTab", openTypeScriptReaderInNewTab));

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('typescript-reader.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from typescript-reader!');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	tabProvider.doGc();
}
