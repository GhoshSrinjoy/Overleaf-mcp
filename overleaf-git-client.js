import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
const execAsync = promisify(exec);

const DEFAULT_COMMIT_MESSAGE = 'Update via Overleaf MCP';

function resolveAuthorEnv() {
    const newEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

    if (process.env.OVERLEAF_GIT_AUTHOR_NAME) {
        newEnv.GIT_AUTHOR_NAME = process.env.OVERLEAF_GIT_AUTHOR_NAME;
        newEnv.GIT_COMMITTER_NAME = process.env.OVERLEAF_GIT_AUTHOR_NAME;
    }

    if (process.env.OVERLEAF_GIT_AUTHOR_EMAIL) {
        newEnv.GIT_AUTHOR_EMAIL = process.env.OVERLEAF_GIT_AUTHOR_EMAIL;
        newEnv.GIT_COMMITTER_EMAIL = process.env.OVERLEAF_GIT_AUTHOR_EMAIL;
    }

    return newEnv;
}

function resolveRepoPath(basePath, targetPath) {
    const resolved = path.resolve(basePath, targetPath);
    if (!resolved.startsWith(path.resolve(basePath))) {
        throw new Error(`Path ${targetPath} escapes repository root`);
    }
    return resolved;
}

class OverleafGitClient {
    constructor(gitToken, projectId, tempDir = './temp') {
        this.gitToken = gitToken;
        this.projectId = projectId;
        this.tempDir = tempDir;
        this.repoUrl = `https://git:${gitToken}@git.overleaf.com/${projectId}`;
        this.localPath = path.join(tempDir, projectId);
    }

    async cloneOrPull() {
        try {
            await fs.access(this.localPath);
            await execAsync('git pull', {
                cwd: this.localPath,
                env: resolveAuthorEnv(),
            });
        } catch {
            await fs.mkdir(this.tempDir, { recursive: true });
            await execAsync(`git clone "${this.repoUrl}" "${this.localPath}"`, {
                env: resolveAuthorEnv(),
            });
        }
    }

    async listFiles(extension = '.tex') {
        await this.cloneOrPull();
        
        const files = [];
        async function walk(dir) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && entry.name !== '.git') {
                    await walk(fullPath);
                } else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) {
                    files.push(fullPath);
                }
            }
        }
        
        await walk(this.localPath);
        return files.map(f => path.relative(this.localPath, f));
    }

    async readFile(filePath) {
        await this.cloneOrPull();
        const fullPath = resolveRepoPath(this.localPath, filePath);
        return await fs.readFile(fullPath, 'utf8');
    }

    async writeFile(filePath, content) {
        await this.cloneOrPull();
        const fullPath = resolveRepoPath(this.localPath, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf8');
    }

    async stageChanges(filePath) {
        await this.cloneOrPull();
        const env = resolveAuthorEnv();
        if (filePath) {
            await execAsync(`git add "${filePath}"`, {
                cwd: this.localPath,
                env,
            });
        } else {
            await execAsync('git add -A', {
                cwd: this.localPath,
                env,
            });
        }
    }

    async hasPendingChanges() {
        await this.cloneOrPull();
        const env = resolveAuthorEnv();
        const { stdout } = await execAsync('git status --porcelain', {
            cwd: this.localPath,
            env,
        });
        return stdout.trim().length > 0;
    }

    async commitAndPush(commitMessage = DEFAULT_COMMIT_MESSAGE) {
        await this.cloneOrPull();
        const env = resolveAuthorEnv();

        const { stdout } = await execAsync('git status --porcelain', {
            cwd: this.localPath,
            env,
        });

        if (!stdout.trim()) {
            return { committed: false, pushed: false };
        }

        const safeMessage = commitMessage.replace(/"/g, '\\"');

        await execAsync('git add -A', {
            cwd: this.localPath,
            env,
        });

        await execAsync(`git commit -m "${safeMessage}"`, {
            cwd: this.localPath,
            env,
        });

        await execAsync('git push', {
            cwd: this.localPath,
            env,
        });

        return { committed: true, pushed: true };
    }

    async updateFile(filePath, content, commitMessage = DEFAULT_COMMIT_MESSAGE) {
        await this.writeFile(filePath, content);
        await this.stageChanges(filePath);
        return this.commitAndPush(commitMessage);
    }

    async getSections(filePath) {
        const content = await this.readFile(filePath);
        
        const sections = [];
        const sectionRegex = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]+)\}/g;
        
        let match;
        let lastIndex = 0;
        
        while ((match = sectionRegex.exec(content)) !== null) {
            const type = match[1];
            const title = match[2];
            const startIndex = match.index;
            
            if (sections.length > 0) {
                sections[sections.length - 1].content = content.substring(lastIndex + match[0].length, startIndex).trim();
            }
            
            sections.push({
                type,
                title,
                startIndex,
                content: ''
            });
            
            lastIndex = startIndex;
        }
        
        if (sections.length > 0) {
            sections[sections.length - 1].content = content.substring(lastIndex + sections[sections.length - 1].title.length + 3).trim();
        }
        
        return sections;
    }

    async getSection(filePath, sectionTitle) {
        const sections = await this.getSections(filePath);
        return sections.find(s => s.title === sectionTitle);
    }

    async getSectionsByType(filePath, type) {
        const sections = await this.getSections(filePath);
        return sections.filter(s => s.type === type);
    }
}

export default OverleafGitClient;
