#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec as callbackExec } from "child_process";
import util from "util";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import https from "https";
import http from "http";

const exec = util.promisify(callbackExec);

// Environment variable for the image upload URL
// 从环境变量读取图片上传URL
const IMAGE_UPLOAD_URL = process.env.IMAGE_UPLOAD_URL;

// Validate required environment variable for upload URL
// 验证必要的环境变量 IMAGE_UPLOAD_URL 是否已设置
if (!IMAGE_UPLOAD_URL) {
  throw new Error(
    "Missing required environment variable: IMAGE_UPLOAD_URL. This variable must be set to the target image hosting service's upload API endpoint."
  );
}


// Helper function to download file using native Node.js modules (replaces wget)
// 使用Node.js原生模块下载文件 (替代wget)
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, { timeout: 15000 }, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
        return;
      }

      const fileStream = createWriteStream(destPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (err: Error) => {
        fs.unlink(destPath).catch(() => {});
        reject(err);
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

// Helper function to upload file using native Node.js modules (replaces curl)
// 使用Node.js原生模块上传文件 (替代curl)
async function uploadFile(filePath: string, uploadUrl: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    try {
      const fileBuffer = await fs.readFile(filePath);
      const filename = path.basename(filePath);
      const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString('hex')}`;

      const payload: Buffer[] = [];
      payload.push(Buffer.from(`--${boundary}\r\n`));
      payload.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`));
      payload.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`));
      payload.push(fileBuffer);
      payload.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      const body = Buffer.concat(payload);
      const urlObj = new URL(uploadUrl);
      const protocol = urlObj.protocol === 'https:' ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'Accept': 'application/json',
        },
        timeout: 30000,
      };

      const request = protocol.request(options, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Upload failed: HTTP ${response.statusCode} - ${data}`));
          }
        });
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Upload timeout'));
      });

      request.write(body);
      request.end();
    } catch (error) {
      reject(error);
    }
  });
}

// Helper function to get file extension from a URL or a filename
// 获取文件扩展名的辅助函数 (可用于URL或文件名)
function getFileExtension(inputString: string): string {
  let filenameOrPath = inputString;
  try {
    // Check if it's a URL and try to get pathname
    const url = new URL(inputString);
    filenameOrPath = url.pathname;
  } catch (e) {
    // Not a valid URL, assume it's a filename or path
  }

  const ext = path.extname(filenameOrPath).toLowerCase();
  return ext || ".tmp";
}


const server = new Server(
  {
    name: "image-uploader-mcp-server",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "upload_image_from_url",
        description:
          `Downloads an image from a given URL using native Node.js modules (no wget required). If the downloaded image is in WebP format, it's converted to JPEG using the 'convert' command (ImageMagick). The (potentially converted) image is then uploaded to a pre-configured image hosting service (defined by IMAGE_UPLOAD_URL environment variable) using native Node.js modules (no curl required). Returns the hosting service's response, attempting to parse and return the full image URL. Only requires 'convert' (ImageMagick) to be installed if WebP conversion is needed.`,
        inputSchema: {
          type: "object",
          properties: {
            image_url: {
              type: "string",
              description: "The URL of the image to download and upload.",
            },
            filename_prefix: {
              type: "string",
              description: "(Optional) A prefix for the temporary filename. A random string will be appended.",
              default: "mcp_upload_",
            }
          },
          required: ["image_url"],
        },
        outputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            message: { type: "string", description: "Success or error message." }, 
            upload_response: { type: "string", description: "Raw response from the image hosting service." }, 
            uploaded_image_url: { type: "string", description: "(If successful and parsable) The full, directly viewable URL of the uploaded image."} 
          }
        }
      },
    ],
  };
});

// Using Promise<any> for the return type as the specific ToolResponse type might not be exported
// or might have a different name in the current SDK version.
// The returned object structure adheres to MCP standards for tool responses.
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => { 
  if (request.params.name === "upload_image_from_url") {
    const {
      image_url,
      filename_prefix = "mcp_upload_",
    } = request.params.arguments as {
      image_url: string;
      filename_prefix?: string;
    };

    const upload_url_from_env = IMAGE_UPLOAD_URL;

    if (!image_url) { 
      return {
        content: [ { type: "text", text: "Error: image_url is required." } ],
        isError: true,
      };
    }
    if (!upload_url_from_env) { 
        return {
            content: [ { type: "text", text: "Error: Server configuration error - IMAGE_UPLOAD_URL is not set." } ],
            isError: true,
          };
    }

    // Determine initial extension from URL for naming, but actual type check will happen after download
    const initialFileExtension = getFileExtension(image_url);
    const randomSuffix = crypto.randomBytes(8).toString("hex");
    // Base temporary filename without extension, will be added after download/conversion
    const tempFileBaseName = `${filename_prefix}${randomSuffix}`;
    let localImagePath = path.join(os.tmpdir(), `${tempFileBaseName}${initialFileExtension}`);
    let finalImagePathForUpload = localImagePath; // This might change if conversion happens
    let convertedImagePath: string | undefined = undefined;


    console.error(`Attempting to download: ${image_url} to ${localImagePath}`);

    try {
      // 1. Download the image using native Node.js modules (replaces wget)
      console.error(`Downloading from: ${image_url}`);
      await downloadFile(image_url, localImagePath);
      console.error(`Image downloaded successfully: ${localImagePath}`); 

      // Check if the downloaded file is WebP by its extension
      // For more robust type checking, a library like 'file-type' could be used after download.
      // Here, we'll rely on the extension of the downloaded file's name.
      const downloadedFileExtension = getFileExtension(localImagePath); // Get extension of actual downloaded file

      if (downloadedFileExtension === ".webp") {
        console.error(`Downloaded image ${localImagePath} is WebP. Attempting conversion to JPEG.`);
        convertedImagePath = path.join(os.tmpdir(), `${tempFileBaseName}.jpg`);
        const convertCommand = `convert "${localImagePath}" "${convertedImagePath}"`;
        console.error(`Executing convert: ${convertCommand}`);
        await exec(convertCommand);
        console.error(`Image converted successfully to JPEG: ${convertedImagePath}`);
        finalImagePathForUpload = convertedImagePath; // Upload the converted JPEG
      } else {
        finalImagePathForUpload = localImagePath; // Upload the original if not WebP
      }

      // 2. Upload the image (original or converted) using native Node.js modules (replaces curl)
      console.error(`Uploading image from: ${finalImagePathForUpload}`);
      const curlStdout = await uploadFile(finalImagePathForUpload, upload_url_from_env);
      console.error(`Image uploaded. Raw response: ${curlStdout}`); 

      let uploadedImageUrl: string | undefined = undefined;
      let parsedSuccessfully = false;

      try {
        const jsonResponse = JSON.parse(curlStdout);

        // Try different common response formats
        if (jsonResponse?.status === true && jsonResponse?.data?.links?.url) {
          // Lsky Pro format
          uploadedImageUrl = jsonResponse.data.links.url;
          parsedSuccessfully = true;
          console.error(`Parsed Lsky Pro format URL: ${uploadedImageUrl}`);
        } else if (Array.isArray(jsonResponse) && jsonResponse.length > 0 && jsonResponse[0]?.src) {
          // Array format with relative src
          const relativeSrc = jsonResponse[0].src;
          const baseUrl = new URL(upload_url_from_env).origin;
          uploadedImageUrl = new URL(relativeSrc, baseUrl).href;
          parsedSuccessfully = true;
          console.error(`Parsed array format URL: ${uploadedImageUrl}`);
        } else if (jsonResponse?.data?.url) {
          // Generic data.url format
          let tempUrl = jsonResponse.data.url;
          if (tempUrl && !tempUrl.startsWith('http://') && !tempUrl.startsWith('https://')) {
            const baseUrl = new URL(upload_url_from_env).origin;
            uploadedImageUrl = new URL(tempUrl, baseUrl).href;
          } else {
            uploadedImageUrl = tempUrl;
          }
          parsedSuccessfully = true;
          console.error(`Parsed generic data.url format: ${uploadedImageUrl}`);
        } else if (jsonResponse?.url) {
          // Direct url field
          uploadedImageUrl = jsonResponse.url;
          parsedSuccessfully = true;
          console.error(`Parsed direct url format: ${uploadedImageUrl}`);
        }
      } catch (parseError) {
        console.error(`Could not parse JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }

      if (!parsedSuccessfully) {
        console.warn("Failed to parse image URL from response. Raw response is available.");
      }

      return {
        content: [
          {
            type: "text",
            text: uploadedImageUrl
              ? `Upload successful. Image URL: ${uploadedImageUrl}`
              : `Upload completed but could not parse image URL. Raw response: ${curlStdout}`,
          },
        ],
        toolMetadata: {
          raw_response: curlStdout,
          uploaded_image_url: uploadedImageUrl,
          status: uploadedImageUrl ? "success" : "partial_success_unknown_url",
          converted_to_jpeg: !!convertedImagePath,
        }
      };
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error during image processing: ${errorMessage}`);
      if (error.stdout) console.error(`Stdout: ${error.stdout}`);
      if (error.stderr) console.error(`Stderr: ${error.stderr}`);

      return {
        content: [
          {
            type: "text",
            text: `Error processing image: ${errorMessage}${error.stderr ? `\nDetails: ${error.stderr}` : ''}`,
          },
        ],
        isError: true,
        toolMetadata: {
          error_details: errorMessage,
          stderr: error.stderr || null,
          stdout: error.stdout || null,
          status: "failure"
        }
      };
    } finally {
      // 3. Clean up the downloaded file(s)
      const filesToDelete = [localImagePath];
      if (convertedImagePath) {
        filesToDelete.push(convertedImagePath);
      }

      await Promise.all(
        filesToDelete.map(async (filePath) => {
          if (filePath) {
            try {
              await fs.access(filePath);
              await fs.unlink(filePath);
              console.error(`Temporary file deleted: ${filePath}`);
            } catch (cleanupError) {
              if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.error(`Error deleting temporary file ${filePath}: ${cleanupError}`);
              }
            }
          }
        })
      );
    }
  }

  return {
    content: [{ type: "text", text: `Error: Unknown tool name '${request.params.name}'.` }], 
    isError: true,
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "MCP Image Uploader Server v0.2.0 running on stdio. Waiting for requests..."
  );
  console.error(`Using image upload URL from environment: ${IMAGE_UPLOAD_URL}`);
  console.warn("Note: Only 'convert' (ImageMagick) is required for WebP conversion. wget and curl are no longer needed.");
}

main().catch((error) => {
  console.error("Server crashed:", error); 
  process.exit(1);
});

