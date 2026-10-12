import express, { type Request, type Response } from 'express';
import cors from 'cors';
import * as ftp from 'basic-ftp';
import { Client } from 'basic-ftp';
import { Readable, Writable } from 'stream';
import multer from 'multer';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configure multer for memory storage to handle multipart/form-data uploads
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/deploy', async (req: Request, res: Response) => {
    const { host, user, password, htmlString, targetFolder = 'public_html' } = req.body;

    if (!host || !user || !password || !htmlString) {
        return res.status(400).json({ error: 'Missing required FTP parameters or HTML content.' });
    }

    const client = new Client();
    client.ftp.verbose = true; 

    try {
        await client.access({
            host,
            user,
            password,
            secure: false
        });

        await client.ensureDir(targetFolder);

        const stream = Readable.from([htmlString]);
        await client.uploadFrom(stream, 'index.html');

        res.status(200).json({ success: true, message: 'Website successfully deployed live!' });
    } catch (error) {
        console.error('FTP Deployment Error:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    } finally {
        client.close();
    }
});

app.post('/api/generate', async (req: Request, res: Response) => {
    try {
        const { prompt, currentHtml } = req.body; 
        const apiKey = process.env.OPENROUTER_API_KEY;

        if (!apiKey) {
            return res.status(500).json({ success: false, error: 'OPENROUTER_API_KEY is missing' });
        }

        const fullPrompt = `${prompt}\n\nCURRENT HTML TO MODIFY:\n${currentHtml}`;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "openai/gpt-4o", 
                messages: [
                    { role: "user", content: fullPrompt } 
                ]
            })
        });

        const data = await response.json();
        
        if (data.error) throw new Error(data.error.message);

        return res.json({ 
            success: true, 
            html: data.choices[0].message.content 
        });

    } catch (error: any) {
        console.error('AI Generation Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 1. LIST DIRECTORY CONTENTS (WITH RECURSIVE SEARCH SUPPORT)
app.post('/api/ftp/list', async (req: Request, res: Response) => {
    const { host, user, password, path = '/', search } = req.body;
    const client = new ftp.Client();
    
    // Track if the frontend cancels the request to prevent ghost connections
    let isAborted = false;
    req.on('close', () => { isAborted = true; });

    try {
        await client.access({ host, user, password, secure: false });

        // 1A. IF SEARCH QUERY EXISTS: Perform a bounded recursive search
        if (search && search.trim() !== '') {
            const query = search.trim().toLowerCase();
            const results: any[] = [];
            const maxDepth = 3; // Keep depth small to prevent FTP timeouts
            let folderCount = 0;

            async function crawl(currentDir: string, depth: number) {
                // Short-circuit if aborted by user, or if we hit safe depth limits
                if (isAborted || depth > maxDepth || folderCount > 100) return;
                
                try {
                    const list = await client.list(currentDir);
                    folderCount++;
                    
                    for (const item of list) {
                        if (isAborted) return;
                        if (item.name === '.' || item.name === '..') continue;

                        const itemPath = `${currentDir === '/' ? '' : currentDir}/${item.name}`;
                        const isFolder = item.type === 2; // 2 corresponds to directory

                        // Check if file/folder matches the search query
                        if (item.name.toLowerCase().includes(query)) {
                            results.push({
                                id: itemPath,
                                name: item.name,
                                isFolder: isFolder,
                                size: item.size,
                                modifiedTime: item.modifiedAt
                            });
                        }

                        // Recurse into subfolders
                        if (isFolder) {
                            await crawl(itemPath, depth + 1);
                        }
                    }
                } catch (err) {
                    // Ignore permission/read errors on specific subfolders and continue
                }
            }

            await crawl(path, 0);
            return res.json({ success: true, files: results });
        } 
        
        // 1B. DEFAULT: Normal Directory Listing (No Search)
        else {
            const list = await client.list(path);
            const formattedList = list.map(item => ({
                id: `${path === '/' ? '' : path}/${item.name}`,
                name: item.name,
                isFolder: item.type === 2, 
                size: item.size,
                modifiedTime: item.modifiedAt
            }));
            return res.json({ success: true, files: formattedList });
        }
    } catch (err: any) {
        console.error("FTP List Error:", err.message);
        // Only return an error if the user didn't intentionally cancel the request
        if (!isAborted) {
            return res.status(500).json({ success: false, error: err.message });
        }
    } finally {
        if (!client.closed) {
            client.close();
        }
    }
});

// 2. READ A FILE
app.post('/api/ftp/read', async (req: any, res: any) => {
    const { host, user, password, filePath } = req.body;
    const client = new ftp.Client();
    try {
        await client.access({ host, user, password, secure: false });
        const stream = new Writable();
        let fileContent = '';
        stream._write = function (chunk: any, encoding: any, done: any) {
            fileContent += chunk.toString();
            done();
        };
        await client.downloadTo(stream, filePath);
        res.json({ success: true, content: fileContent });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.close();
    }
});

// 3. CREATE A NEW FOLDER
app.post('/api/ftp/mkdir', async (req: any, res: any) => {
    const { host, user, password, folderPath, path, dirPath } = req.body;
    // Catch whatever path property the frontend passes
    const finalPath = folderPath || path || dirPath;
    
    if (!finalPath) return res.status(400).json({ success: false, error: "Target path required" });

    const client = new ftp.Client();
    try {
        await client.access({ host, user, password, secure: false });
        await client.ensureDir(finalPath);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.close();
    }
});

// 4. DELETE A FILE OR FOLDER (CRASH PROOFED)
app.post('/api/ftp/delete', async (req: any, res: any) => {
    // Catch every possible path variant the frontend might send
    const { host, user, password, targetPath, path, filePath, dirPath, folderPath, isFolder } = req.body;
    const finalPath = targetPath || path || filePath || dirPath || folderPath;

    if (!finalPath) {
        return res.status(400).json({ success: false, error: "Target path is required" });
    }

    const client = new ftp.Client();
    try {
        await client.access({ host, user, password, secure: false });
        if (isFolder) {
            await client.removeDir(finalPath);
        } else {
            await client.remove(finalPath);
        }
        res.json({ success: true });
    } catch (err: any) {
        console.error("FTP Delete Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.close();
    }
});

// 5. FTP FILE UPLOAD (BINARY SAFE via MULTER)
// Injecting upload.single('file') middleware to process FormData natively
app.post('/api/ftp/upload', upload.single('file'), async (req: any, res: any) => {
    // Extract credentials and paths from the FormData body
    const { host, user, password, filePath, targetPath, path } = req.body;
    const finalPath = filePath || targetPath || path;

    if (!host || !user || !password || !req.file || !finalPath) {
        return res.status(400).json({ success: false, error: 'Missing required FTP credentials, path, or file data.' });
    }

    const client = new ftp.Client();

    try {
        // Create a readable stream directly from Multer's memory buffer
        const stream = Readable.from(req.file.buffer);

        // Connect to FTP
        await client.access({
            host: host,
            user: user,
            password: password,
            secure: false 
        });

        // Isolate the directory path to ensure it exists before uploading
        const dirPath = finalPath.substring(0, finalPath.lastIndexOf('/')) || '/';
        await client.ensureDir(dirPath);
        
        // Upload the binary stream directly to the target file path
        await client.uploadFrom(stream, finalPath);
        client.close();

        // Construct public URL
        const baseUrl = host.toLowerCase().startsWith('ftp.') ? host.substring(4) : host;
        const publicUrl = `https://${baseUrl}${finalPath}`;

        return res.json({ success: true, publicUrl: publicUrl });

    } catch (error: any) {
        console.error('FTP Upload Error:', error);
        if (!client.closed) {
            client.close();
        }
        return res.status(500).json({ success: false, error: error.message || 'Failed to upload to FTP server.' });
    }
});

// Add this back to server.ts in sae-ftp-bridge
app.post('/api/ftp/rename', async (req: any, res: any) => {
    const { host, user, password, oldPath, newPath } = req.body;
    const client = new ftp.Client();
    try {
        await client.access({ host, user, password, secure: false });
        await client.rename(oldPath, newPath);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.close();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SAE FTP bridge listening on port ${PORT}`);
});