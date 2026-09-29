import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { Client } from 'basic-ftp';
import { Readable } from 'stream';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SAE FTP bridge listening on port ${PORT}`);
});