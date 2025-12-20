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

    async runGit(command, options = {}) {
        const env = { ...resolveAuthorEnv(), ...(options.env || {}) };
        const { stdout, stderr } = await execAsync(command, {
            cwd: options.cwd || this.localPath,
            env,
            maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
        });
        return { stdout, stderr };
    }

    async cloneOrPull() {
        try {
            await fs.access(this.localPath);
            await this.runGit('git pull');
        } catch {
            await fs.mkdir(this.tempDir, { recursive: true });
            await this.runGit(`git clone "${this.repoUrl}" "${this.localPath}"`, {
                cwd: this.tempDir,
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
        if (filePath) {
            await this.runGit(`git add "${filePath}"`);
        } else {
            await this.runGit('git add -A');
        }
    }

    async hasPendingChanges() {
        await this.cloneOrPull();
        const { stdout } = await this.runGit('git status --porcelain');
        return stdout.trim().length > 0;
    }

    async commitAndPush(
        commitMessage = DEFAULT_COMMIT_MESSAGE,
        { push = true, allowEmpty = false, paths = [] } = {},
    ) {
        await this.cloneOrPull();
        const { stdout } = await this.runGit('git status --porcelain');

        if (!stdout.trim() && !allowEmpty) {
            return { committed: false, pushed: false };
        }

        const safeMessage = commitMessage.replace(/"/g, '\\"');

        if (paths && paths.length > 0) {
            await this.runGit(`git add ${paths.map((p) => `"${p}"`).join(' ')}`);
        } else {
            await this.runGit('git add -A');
        }

        await this.runGit(`git commit -m "${safeMessage}"${allowEmpty ? ' --allow-empty' : ''}`);

        if (push) {
            await this.runGit('git push');
        }

        return { committed: true, pushed: push };
    }

    async updateFile(filePath, content, commitMessage = DEFAULT_COMMIT_MESSAGE) {
        await this.writeFile(filePath, content);
        await this.stageChanges(filePath);
        return this.commitAndPush(commitMessage, { paths: [filePath] });
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

    async getLog({ limit = 20, path: logPath, since, until } = {}) {
        await this.cloneOrPull();
        const args = [`-n ${Math.max(1, Math.min(limit, 200))}`, '--date=iso-strict', '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s'];
        if (since) args.push(`--since="${since}"`);
        if (until) args.push(`--until="${until}"`);
        const pathPart = logPath ? ` -- "${logPath}"` : '';
        const { stdout } = await this.runGit(`git log ${args.join(' ')}${pathPart}`);
        return stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [hash, author, email, date, subject] = line.split('\x1f');
                return { hash, author, email, date, subject };
            });
    }

    async getDiff({ fromRef, toRef, paths = [], contextLines = 3, maxOutputChars = 200000 } = {}) {
        await this.cloneOrPull();
        const safeContext = Math.max(0, Math.min(contextLines, 10));
        const pathArgs = paths.length ? ` -- ${paths.map((p) => `"${p}"`).join(' ')}` : '';

        let diffCmd;
        if (fromRef && toRef) {
            diffCmd = `git diff --no-color -U${safeContext} ${fromRef} ${toRef}${pathArgs}`;
        } else if (fromRef) {
            diffCmd = `git diff --no-color -U${safeContext} ${fromRef}${pathArgs}`;
        } else {
            diffCmd = `git diff --no-color -U${safeContext}${pathArgs}`;
        }

        const { stdout } = await this.runGit(diffCmd, { maxBuffer: maxOutputChars * 2 });
        const diff = stdout || '';
        const truncated = diff.length > maxOutputChars;
        return {
            diff: truncated ? diff.slice(0, maxOutputChars) : diff,
            truncated,
        };
    }
}

export default OverleafGitClient;
