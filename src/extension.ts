import * as vscode from 'vscode';
import { Constants } from './constants';
import { CrowdinConfigHolder } from './plugin/crowdinConfigHolder';
import { ProgressTreeProvider } from './plugin/progress/progressTreeProvider';
import { LocalTranslationsProvider } from './plugin/translations/localTranslationsProvider';
import { downloadTranslation, openSearchTranslations } from './plugin/translations/downloadTranslationsCommand';
import { Diagnostics } from './plugin/diagnostics/diagnostics';
import { addEntry } from './plugin/translations/addEntryAction';
import { uploadTranslations, uploadTranslationSource } from './plugin/translations/uploadTranslationsCommand';
import { genProtoCommand } from './plugin/generator/protoGenerator';
import { genMobxCommand } from './plugin/generator/mobxstoreGenerator';
import { WrapObserverCodeActionProvider, wrapObserverCommand } from './plugin/diagnostics/wrapWithObserver';
import { importImage } from './plugin/importImages/importImageAction';
import __register_flutter_preview, {
  deactivate as __deactivate_flutter_preview,
} from "./support-flutter-preview";

export async function activate(context: vscode.ExtensionContext) {
  Constants.initialize(context);

  const diagnostics = new Diagnostics();
  const configHolder = new CrowdinConfigHolder();
  // const progressProvider = new ProgressTreeProvider(configHolder);
  // const localTranslationsProvider = new LocalTranslationsProvider(vscode.workspace.rootPath);

  // configHolder.addListener(() => progressProvider.refresh());
  configHolder.load();

  // vscode.window.registerTreeDataProvider('translationProgress', progressProvider);
  // vscode.window.registerTreeDataProvider('localTranslations', localTranslationsProvider);

  vscode.commands.registerCommand(Constants.OPEN_TMS_FILE_COMMAND, fsPath => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fsPath)));

  // vscode.commands.registerCommand('localTranslations.showEntry', args => localTranslationsProvider.showEntry(args));
  vscode.commands.registerCommand('localTranslations.create', args => addEntry(args));
  vscode.commands.registerCommand('localTranslations.download', () => downloadTranslation(configHolder));
  vscode.commands.registerCommand('localTranslations.upload', () => uploadTranslations(configHolder));
  vscode.commands.registerCommand('localTranslations.upload.json', (args) => uploadTranslationSource(args, configHolder));
  vscode.commands.registerCommand('localTranslations.search', () => openSearchTranslations());

  // vscode.commands.registerCommand('translationProgress.refresh', () => progressProvider.refresh());
  vscode.commands.registerCommand('generator.mobx', args => genMobxCommand(args));
  vscode.commands.registerCommand('generator.proto', args => genProtoCommand(args, configHolder));
  vscode.commands.registerCommand('generator.proto.update', args => {
    const uri = args as vscode.Uri;
    const newUri = vscode.Uri.file(uri.fsPath.replace('.twirp.dart', '.proto'));
    genProtoCommand(newUri, configHolder)
  });

  vscode.commands.registerCommand('hammer.wrapObserver', args => wrapObserverCommand(args));

  vscode.commands.registerCommand('images.import', args => importImage(args));
  __register_flutter_preview(context);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(Constants.AUTO_REFRESH_PROPERTY)) {
      configHolder.load();
    }
  }));

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: "**/*.{dart,dartx}", scheme: "file" },
      new WrapObserverCodeActionProvider()
    )
  );


  // Ensure we have a Dart extension.
  // const dartExt = vscode.extensions.getExtension('Dart-Code.dart-code');
  // if (!!dartExt) {
  //     dartExt.activate();
  // This should not happen since the Flutter extension has a dependency on the Dart one
  // but just in case, we'd like to give a useful error message.
  // throw new Error("The Dart extension is not installed, Flutter extension is unable to activate.");
  // }

  diagnostics.init(context, undefined);
}
// this method is called when your extension is deactivated
export function deactivate() {
  __deactivate_flutter_preview();
}
