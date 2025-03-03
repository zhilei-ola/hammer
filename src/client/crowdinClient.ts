import Crowdin, { Credentials, ProjectsGroupsModel, ResponseList, SourceFilesModel } from '@crowdin/crowdin-api-client';
import * as AdmZip from 'adm-zip';
import axios from 'axios';
import * as fs from 'fs';
import * as minimatch from 'minimatch';
import * as path from 'path';
import { Scheme } from '../config/fileModel';
import { Constants } from '../constants';
import { SourceFiles } from '../model/sourceFiles';
import { PathUtil } from '../util/pathUtil';
import * as vscode from 'vscode';

export class CrowdinClient {

    readonly crowdin: Crowdin;

    constructor(
        readonly projectId: number,
        readonly apiKey: string,
        readonly branch?: string,
        readonly organization?: string,
        readonly supportLanguages?: string[]) {
        const credentials: Credentials = {
            token: apiKey,
            organization: organization
        };
        this.crowdin = new Crowdin(credentials, {
            userAgent: `hammer-vscode-plugin/${Constants.PLUGIN_VERSION} vscode/${Constants.VSCODE_VERSION}`,
            retryConfig: {
                conditions: [],
                retries: Constants.CLIENT_RETRIES,
                waitInterval: Constants.CLIENT_RETRY_WAIT_INTERVAL_MS
            }
        });
    }

    /**
     * Downloads zip archive from Crowdin system and unzip it in pre-defined folder
     * 
     * @param unzipFolder folder where to unzip downloaded files
     * @param sourceFilesArr list of sources and translations from configuration file and found source files
     */
    async download(unzipFolder: string, sourceFilesArr: SourceFiles[], config: any): Promise<any> {
        try {
            let branchId: number | undefined;
            if (!!this.branch) {
                const branches = await this.crowdin.sourceFilesApi.listProjectBranches(this.projectId, this.branch);
                const foundBranch = branches.data.find(e => e.data.name === this.branch);
                if (!!foundBranch) {
                    branchId = foundBranch.data.id;
                }
            }
            const build = await this.crowdin.translationsApi.buildProject(this.projectId, { branchId });
            let finished = false;

            while (!finished) {
                const status = await this.crowdin.translationsApi.checkBuildStatus(this.projectId, build.data.id);
                finished = status.data.status === 'finished';
            }

            const downloadLink = await this.crowdin.translationsApi.downloadTranslations(this.projectId, build.data.id);
            const resp = await axios.get(downloadLink.data.url, { responseType: 'arraybuffer' });
            const zip = new AdmZip(resp.data);

            
            
            const filesToUnzip = zip.getEntries().filter(file => {
                if(file.isDirectory) return;

                let pathsegs = path.dirname(file.entryName).split('/');
                pathsegs?.shift();
                const fileName = pathsegs.join('/');
                if(fileName && fileName.startsWith("client")){
                    return true;
                }
                
                return false;
            });

            let results: string[] = [];
            filesToUnzip.forEach(file => {

                let entryName = file.entryName;
                let pathsegs =entryName.split('/')
                let language = pathsegs.shift();
                const downloadedCrowdinDest = "/"+pathsegs.join("/")
                // language = language?.replace('-', '_');
                // if(this.supportLanguages?.indexOf(language??'') == -1) return;

                let filename = pathsegs.pop() ?? '';
                let filecomps = filename.split('.')[0].split('_');
                filename = filecomps.pop() ?? '';
                let modulename = filecomps.join('_') ?? '';
                let moduleDir = config.modulePath ?? Constants.DEFAULT_MODULE_DIR;

                if(modulename == Constants.ROOT_MODULE_NAME) {
                    modulename = '';
                    moduleDir = '';
                }
                const sourceFileEntry = sourceFilesArr.find((e) => e.dest === downloadedCrowdinDest)
                const twoLetterCodeMap = sourceFileEntry?.languageMapping?.two_letters_code;
                const twoLetterCode = (twoLetterCodeMap as any)[language ?? ""] ?? language;
                entryName = path.join(moduleDir, modulename, 'assets', 'locale',  `${filename}_${twoLetterCode}.json`);
                
                const filePath = path.join(unzipFolder, entryName);
                const directory = path.dirname(filePath);
                if (fs.existsSync(directory)) {
                    results.push(entryName);
                    fs.writeFileSync(filePath, file.getData());
                }
            });

            return results;
        } catch (error) {
            throw new Error(`Failed to download translations for project ${this.projectId}. ${this.getErrorMessage(error)}`);
        }
    }

    async getBranchId(): Promise<number | undefined> {
        if (!!this.branch) {
            try {
                const branches = await this.crowdin.sourceFilesApi.listProjectBranches(this.projectId, this.branch);
                const foundBranch = branches.data.find(e => e.data.name === this.branch);
                if (!!foundBranch) {
                    return foundBranch.data.id;
                } else {
                    const res = await this.crowdin.sourceFilesApi.createBranch(this.projectId, {
                        name: this.branch
                    });
                    return res.data.id;
                }
            } catch (error) {
                try {
                    if (!this.concurrentIssue(error)) {
                        throw error;
                    }
                    return await this.waitAndFindBranch(this.branch);
                } catch (error) {
                    throw new Error(`Failed to create/find branch for project ${this.projectId}. ${this.getErrorMessage(error)}`);
                }
            }
        }
        return undefined
    }

    async uploadFile(
        fileName: string,
        fileId: number,
        fileRawData: Buffer, // binary file data
        exportPattern: string,
        uploadOption?: SourceFilesModel.UpdateOption,
    ): Promise<void> {
        try {
            
            const resp = await this.crowdin.uploadStorageApi.addStorage(fileName, fileRawData);
            const storageId = resp.data.id;
            
            await this.crowdin.sourceFilesApi.updateOrRestoreFile(this.projectId, fileId, {
                storageId: storageId,
                updateOption: SourceFilesModel.UpdateOption.KEEP_TRANSLATIONS_AND_APPROVALS,
                exportOptions: {
                    exportPattern: exportPattern
                }
            });

        } catch (error) {
            throw new Error(`Failed to create/update file ${fileName} for project ${this.projectId}. ${this.getErrorMessage(error)}`);
        }
    }

    /**
     * Uploads file to the Crowdin system. Creates needed folders/branch is they are missing.
     * 
     * @param fsPath full path to file
     * @param exportPattern file export pattern
     * @param file file path in crowdin system
     * @param uploadOption upload option
     * @param excludedTargetLanguages excluded target languages
     * @param labels labels
     * @param scheme import scheme
     */
    async upload(
        fsPath: string,
        exportPattern: string,
        file: string,
        uploadOption?: SourceFilesModel.UpdateOption,
        excludedTargetLanguages?: string[],
        labels?: string[],
        scheme?: Scheme
    ): Promise<void> {
        let branchId: number | undefined;

        if (!!this.branch) {
            try {
                const branches = await this.crowdin.sourceFilesApi.listProjectBranches(this.projectId, this.branch);
                const foundBranch = branches.data.find(e => e.data.name === this.branch);
                if (!!foundBranch) {
                    branchId = foundBranch.data.id;
                } else {
                    const res = await this.crowdin.sourceFilesApi.createBranch(this.projectId, {
                        name: this.branch
                    });
                    branchId = res.data.id;
                }
            } catch (error) {
                try {
                    if (!this.concurrentIssue(error)) {
                        throw error;
                    }
                    branchId = await this.waitAndFindBranch(this.branch);
                } catch (error) {
                    throw new Error(`Failed to create/find branch for project ${this.projectId}. ${this.getErrorMessage(error)}`);
                }
            }
        }

        let parentId: number | undefined;
        //check if file has parent folders
        if (path.basename(file) !== file) {
            const folders = this.normalizePath(path.dirname(file))
                .split(Constants.CROWDIN_PATH_SEPARATOR)
                .filter(f => f !== '');
            try {
                for (let i = 0; i < folders.length; i++) {
                    const folder = folders[i];
                    try {
                        const dir = await this.findDirectory(folder, parentId, branchId);
                        if (!!dir) {
                            parentId = dir;
                        } else {
                            const resp = await this.crowdin.sourceFilesApi.createDirectory(this.projectId, {
                                branchId: (!!parentId ? undefined : branchId),
                                directoryId: parentId,
                                name: folder
                            });
                            parentId = resp.data.id;
                        }
                    } catch (error) {
                        if (!this.concurrentIssue(error)) {
                            throw error;
                        }
                        parentId = await this.waitAndFindDirectory(folder, parentId, branchId);
                    }
                }
            } catch (error) {
                throw new Error(`Failed to create folders for project ${this.projectId}. ${this.getErrorMessage(error)}`);
            }
        }

        const fileName = path.basename(file);
        const fileContent = fs.readFileSync(fsPath);

        try {
            const resp = await this.crowdin.uploadStorageApi.addStorage(fileName, fileContent);
            const storageId = resp.data.id;
            const files = await this.crowdin.sourceFilesApi.withFetchAll().listProjectFiles(this.projectId, undefined, parentId);
            const foundFile = files.data
                .filter(f => {
                    if (!branchId) {
                        return !f.data.branchId;
                    } else {
                        return f.data.branchId === branchId;
                    }
                })
                .find(f => f.data.name === fileName);
            if (!!foundFile) {
                await this.crowdin.sourceFilesApi.updateOrRestoreFile(this.projectId, foundFile.data.id, {
                    storageId: storageId,
                    updateOption: uploadOption,
                    exportOptions: {
                        exportPattern: exportPattern
                    }
                });
            } else {
                let labelIds;
                if (!!labels) {
                    labelIds = [];
                    const labelsFromRemote = await this.crowdin.labelsApi.withFetchAll().listLabels(this.projectId);
                    for (const label of labels) {
                        const formattedLabel = label.trim().toLowerCase();
                        const foundLabel = labelsFromRemote.data.find(l => l.data.title.toLocaleLowerCase() === formattedLabel);
                        if (foundLabel) {
                            labelIds.push(foundLabel.data.id);
                        } else {
                            try {
                                const createdLabel = await this.crowdin.labelsApi.addLabel(this.projectId, {
                                    title: label.trim()
                                });
                                labelIds.push(createdLabel.data.id);
                            } catch (error) {
                                if (!this.concurrentIssue(error)) {
                                    throw error;
                                }
                                const missingLabel = await this.crowdin.labelsApi.retryService.executeAsyncFunc(async () => {
                                    const allLabels = await this.crowdin.labelsApi.withFetchAll().listLabels(this.projectId);
                                    const neededLabel = allLabels.data.find(l => l.data.title.toLocaleLowerCase() === formattedLabel);
                                    if (neededLabel) {
                                        return neededLabel;
                                    } else {
                                        throw new Error(`Could not find label ${label.trim()} in Crowdin response`);
                                    }
                                });
                                labelIds.push(missingLabel.data.id);
                            }
                        }
                    }
                }
                await this.crowdin.sourceFilesApi.createFile(this.projectId, {
                    branchId: (!!parentId ? undefined : branchId),
                    directoryId: parentId,
                    name: fileName,
                    storageId: storageId,
                    exportOptions: {
                        exportPattern: exportPattern
                    },
                    importOptions: scheme && {
                        scheme: scheme
                    } as unknown as SourceFilesModel.SpreadsheetImportOptions,
                    excludedTargetLanguages,
                    attachLabelIds: labelIds
                });
            }
        } catch (error) {
            throw new Error(`Failed to create/update file ${path.basename(file)} for project ${this.projectId}. ${this.getErrorMessage(error)}`);
        }
    }

    async getDirectoryFiles(dirId?: number) {
        if(!dirId) return undefined;

        const files = await this.crowdin.sourceFilesApi.withFetchAll().listProjectFiles(this.projectId, undefined, dirId);
        return files;
    }

    /**
     * 
     * @param file file path in crowdin
     * @param dirId file path directory id in crowdin
     */
     async getSourceFileContent(fileId: number): Promise<string> {
        if(!fileId) return '';
        
        const downloadLink = await this.crowdin.sourceFilesApi.downloadFile(this.projectId, fileId);
        const content = await axios.get(downloadLink.data.url, { responseType: 'arraybuffer' });

        return content.data;
    }

    /**
     * 
     * @param fsPath file path in fs
     * @param file file path in crowdin
     */
    async downloadSourceFile(fsPath: string, file: string): Promise<void> {
        let branchId: number | undefined;
        if (!!this.branch) {
            const branches = await this.crowdin.sourceFilesApi.listProjectBranches(this.projectId, this.branch);
            const foundBranch = branches.data.find(e => e.data.name === this.branch);
            if (!!foundBranch) {
                branchId = foundBranch.data.id;
            } else {
                throw new Error(`File ${file} does not exist under branch ${this.branch}`);
            }
        }
        let parentId: number | undefined;
        if (path.basename(file) !== file) {
            const folders = this.normalizePath(path.dirname(file))
                .split(Constants.CROWDIN_PATH_SEPARATOR)
                .filter(f => f !== '');
            for (let i = 0; i < folders.length; i++) {
                const folder = folders[i];
                const dir = await this.findDirectory(folder, parentId, branchId);
                if (!!dir) {
                    parentId = dir;
                } else {
                    throw new Error(`File ${file} does not exist under directory ${path.dirname(file)}`);
                }
            }
        }
        const fileName = path.basename(file);
        const files = await this.crowdin.sourceFilesApi.withFetchAll().listProjectFiles(this.projectId, undefined, parentId);
        const foundFile = files.data
            .filter(f => {
                if (!branchId) {
                    return !f.data.branchId;
                } else {
                    return f.data.branchId === branchId;
                }
            })
            .find(f => f.data.name === fileName);
        if (!foundFile) {
            throw new Error(`File ${file} does not exist`);
        }
        const downloadLink = await this.crowdin.sourceFilesApi.downloadFile(this.projectId, foundFile.data.id);
        const content = await axios.get(downloadLink.data.url, { responseType: 'arraybuffer' });
        fs.writeFileSync(fsPath, content.data);
    }


    /**
     * 
     * @param fsFolderPath folder path in fs
     * @param folder folder path in crowdin
     * @param globPatterns patterns for which files should be updated
     */
    async downloadSourceFolder(fsFolderPath: string, folder: string, globPatterns: string[]): Promise<void> {
        const files = await this.crowdin.sourceFilesApi.withFetchAll().listProjectFiles(this.projectId);
        const filteredFiles = files.data
            .filter(f => {
                const filePath = path.normalize(f.data.path);
                if (filePath.startsWith(`${path.sep}${folder}`)) {
                    return globPatterns.some(pattern => minimatch(filePath, pattern));
                }
                return false;
            });
        for (const file of filteredFiles) {
            const fullFilePath = path.join(fsFolderPath, path.normalize(file.data.path));
            const fileDirectory = path.dirname(fullFilePath);
            if (!fs.existsSync(fileDirectory)) {
                fs.mkdirSync(fileDirectory);
            }
            const downloadLink = await this.crowdin.sourceFilesApi.downloadFile(this.projectId, file.data.id);
            const content = await axios.get(downloadLink.data.url, { responseType: 'arraybuffer' });
            fs.writeFileSync(fullFilePath, content.data);
        }
    }

    private waitAndFindDirectory(name: string, parentId?: number, branchId?: number): Promise<number> {
        return this.crowdin.sourceFilesApi.retryService.executeAsyncFunc(async () => {
            const foundDir = await this.findDirectory(name, parentId, branchId);
            if (!!foundDir) {
                return foundDir;
            } else {
                throw new Error(`Could not find directory ${name} in Crowdin response`);
            }
        });
    }

    private async findDirectory(name: string, parentId?: number, branchId?: number): Promise<number | undefined> {
        const dirs = await this.crowdin.sourceFilesApi.withFetchAll().listProjectDirectories(this.projectId, undefined, parentId);
        const foundDir = dirs.data
            .filter(dir => {
                if (!branchId) {
                    return !dir.data.branchId;
                } else {
                    return dir.data.branchId === branchId;
                }
            })
            .find(dir => dir.data.name.toLowerCase() === name.toLowerCase());
        if (!!foundDir) {
            return foundDir.data.id;
        } else {
            return undefined;
        }
    }

    private waitAndFindBranch(name: string): Promise<number> {
        return this.crowdin.sourceFilesApi.retryService.executeAsyncFunc(async () => {
            const branches = await this.crowdin.sourceFilesApi.withFetchAll().listProjectBranches(this.projectId, name);
            const foundBranch = branches.data.find(branch => branch.data.name.toLowerCase() === name.toLowerCase());
            if (!!foundBranch) {
                return foundBranch.data.id;
            } else {
                throw new Error(`Could not find branch ${name} in Crowdin response`);
            }
        });
    }

    private normalizePath(fileName: string): string {
        return fileName.replace(new RegExp('\\' + path.sep, 'g'), Constants.CROWDIN_PATH_SEPARATOR);
    }

    private getErrorMessage(error: any): string {
        if (error.message) {
            return error.message;
        } else if (error.error && error.error.message) {
            return error.error.message;
        } else if (error.errors && Array.isArray(error.errors)) {
            return error.errors
                .filter((e: any) => !!e.error)
                .map((e: any) => e.error)
                .filter((e: any) => Array.isArray(e.errors))
                .map((e: any) => {
                    const key = e.key || '';
                    return key + ' ' + e.errors
                        .map((e1: any) => {
                            if (e1.code && e1.message) {
                                return e1.code + ' ' + e1.message;
                            } else {
                                return JSON.stringify(e1);
                            }
                        })
                        .join(';');
                })
                .join(';');
        } else if (typeof error === 'string' || error instanceof String) {
            return error as string;
        } else {
            return JSON.stringify(error);
        }
    }

    private concurrentIssue(error: any): boolean {
        return this.codeExists(error, 'notUnique')
            || this.codeExists(error, 'parallelCreation');
    }

    private codeExists(e: any, code: string): boolean {
        if (e.errors && Array.isArray(e.errors)) {
            return !!e.errors
                .filter((e: any) => !!e.error)
                .map((e: any) => e.error)
                .filter((e: any) => Array.isArray(e.errors))
                .find((e: any) =>
                    !!e.errors
                        .filter((e1: any) => !!e1.code && (typeof e1.code === 'string' || e1.code instanceof String))
                        .map((e1: any) => e1.code)
                        .find((c: string) => c.toLowerCase() === code.toLowerCase())
                );
        }
        return false;
    }
}