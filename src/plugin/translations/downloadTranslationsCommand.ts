import * as path from 'path';
import * as vscode from 'vscode';
import * as util from 'util';
import * as glob from 'glob';
import { CrowdinClient } from '../../client/crowdinClient';
import { ErrorHandler } from '../../util/errorHandler';
import { SourceFiles } from '../../model/sourceFiles';
import { CrowdinConfigHolder } from '../crowdinConfigHolder';
import { CommonUtil } from '../../util/commonUtil';
import * as fs from 'fs';
import * as yaml from 'yaml';

const asyncGlob = util.promisify(glob);

export const openSearchTranslations = () => {
    vscode.commands.executeCommand('search.action.openNewEditorToSide', '**/assets/locale/*.json');
}



export const downloadTranslation = (configHolder: CrowdinConfigHolder) => {
    return CommonUtil.withProgress(
        async () => {
            try {


                var config: any;
                var workspace: any;
                for (let elem of configHolder.configurations.entries()) {
                    config = elem[0];
                    workspace = elem[1];
                }

                const root = config.basePath ? path.join(workspace.uri.fsPath, config.basePath) : workspace.uri.fsPath;
                
                const roomYaml = path.join(root, 'pubspec.yaml');
                const packagePubspec = yaml.parse(fs.readFileSync(roomYaml, 'utf8'));
                const supportLans = packagePubspec.flutter["assets-filter"];

                const promises = config.files
                    .map(async (f: { source: string; directory:any, translation: any; }) => {

                        let foundFiles = await asyncGlob(f.source, { cwd: root, root: root });
                        const sourceFiles: SourceFiles = {
                            files: foundFiles,
                            sourcePattern: f.source,
                            directoryPattern: f.directory,
                            translationPattern: f.translation
                        };
                        return sourceFiles;
                    });

                    
                const client = new CrowdinClient(
                    config.projectId, config.apiKey, config.branch, config.organization,supportLans
                );
                const sourceFilesArr = await Promise.all(promises);
                //@ts-ignore
                await client.download(root, sourceFilesArr);
            } catch (err) {
                ErrorHandler.handleError(err);
            }
        },
        `Downloading translations...`
    );
};