#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  // ToolResponse, // Removed as it's not exported from types.js
} from "@modelcontextprotocol/sdk/types.js";
import { exec as callbackExec } from "child_process";
import util from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";

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
  
  const ext = path.extname(filenameOrPath).toLowerCase(); // Convert to lowercase for consistent checking
  return ext || ".tmp"; // Default to .tmp if no extension found
}


const server = new Server(
  {
    name: "image-uploader-mcp-server",
    version: "0.1.4", // 版本更新
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
          `Downloads an image from a given URL using wget. If the downloaded image is in WebP format, it's converted to JPEG using the 'convert' command. The (potentially converted) image is then uploaded to a pre-configured image hosting service (defined by IMAGE_UPLOAD_URL environment variable) using curl. Returns the hosting service's response, attempting to parse and return the full image URL. No API token is used. Requires 'wget', 'curl', and 'convert' (ImageMagick) to be installed.`, // 工具描述更新
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
      // 1. Download the image using wget
      const wgetCommand = `wget --tries=3 --timeout=15 -O "${localImagePath}" "${image_url}"`;
      console.error(`Executing wget: ${wgetCommand}`); 
      await exec(wgetCommand);
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

      // 2. Upload the image (original or converted) using curl
      let curlCommand = `curl -s -X POST -F "file=@${finalImagePathForUpload}"`;
      curlCommand += ` -H "Accept: application/json"`;
      curlCommand += ` "${upload_url_from_env}"`; 

      console.error(`Executing curl: ${curlCommand}`); 
      const { stdout: curlStdout, stderr: curlStderr } = await exec(curlCommand);

      if (curlStderr) {
        console.error(`Curl stderr: ${curlStderr}`); 
      }
      console.error(`Image uploaded. Raw response: ${curlStdout}`); 
      
      let uploadedImageUrl: string | undefined = undefined;
      let parsedSuccessfully = false;

      try {
        const jsonResponse = JSON.parse(curlStdout);

        if (jsonResponse && jsonResponse.status === true && jsonResponse.data && jsonResponse.data.links && jsonResponse.data.links.url) {
            uploadedImageUrl = jsonResponse.data.links.url;
            parsedSuccessfully = true;
            console.error(`Parsed Lsky Pro (full URL) uploaded image URL: ${uploadedImageUrl}`); 
        } 
        else if (Array.isArray(jsonResponse) && jsonResponse.length > 0 && jsonResponse[0] && typeof jsonResponse[0].src === 'string') {
            const relativeSrc = jsonResponse[0].src;
            const baseUrl = new URL(upload_url_from_env).origin; 
            uploadedImageUrl = new URL(relativeSrc, baseUrl).href;
            parsedSuccessfully = true;
            console.error(`Parsed relative 'src' and constructed full URL: ${uploadedImageUrl}`); 
        }
        else if (jsonResponse && jsonResponse.data && typeof jsonResponse.data.url === 'string') {
            let tempUrl = jsonResponse.data.url as string; 
            if (tempUrl && !tempUrl.startsWith('http://') && !tempUrl.startsWith('https://')) {
                const baseUrl = new URL(upload_url_from_env).origin;
                uploadedImageUrl = new URL(tempUrl, baseUrl).href;
            } else {
                uploadedImageUrl = tempUrl;
            }
            parsedSuccessfully = true;
            console.error(`Parsed 'data.url' structure. Final URL: ${uploadedImageUrl}`); 
        }

      } catch (parseError) {
        console.error("Could not parse JSON response from image host, or expected fields not found. Raw response will be returned."); 
      }

      if (!parsedSuccessfully) {
          console.warn("Failed to parse a known successful structure from the image host response. The raw response is available."); 
      }

      return {
        content: [
          {
            type: "text",
            text: `Upload attempt finished. Raw response: ${curlStdout}` + (uploadedImageUrl ? ` Constructed/Parsed Image URL: ${uploadedImageUrl}` : " Could not determine final image URL from response."), 
          },
        ],
        toolMetadata: { 
            raw_response: curlStdout,
            uploaded_image_url: uploadedImageUrl,
            status: uploadedImageUrl ? "success" : "partial_success_unknown_url",
            converted_to_jpeg: !!convertedImagePath // Indicate if conversion happened
        }
      };
    } catch (error: any) {
      console.error(`Error during image processing: ${error.message}`); 
      console.error(`Stdout: ${error.stdout}`); 
      console.error(`Stderr: ${error.stderr}`); 
      return {
        content: [
          {
            type: "text",
            text: `Error processing image: ${error.message}. Stderr: ${error.stderr || 'N/A'}. Stdout: ${error.stdout || 'N/A'}`, 
          },
        ],
        isError: true,
        toolMetadata: {
            error_details: error.message,
            stderr: error.stderr,
            stdout: error.stdout,
            status: "failure"
        }
      };
    } finally {
      // 3. Clean up the downloaded file(s)
      const filesToDelete = [localImagePath];
      if (convertedImagePath) {
        filesToDelete.push(convertedImagePath);
      }
      for (const filePath of filesToDelete) {
          if (filePath) { // Ensure filePath is defined
            try {
                await fs.access(filePath); 
                await fs.unlink(filePath);
                console.error(`Temporary file deleted: ${filePath}`); 
            } catch (cleanupError) {
                if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') { // Don't log error if file simply doesn't exist
                    console.error(`Error deleting temporary file ${filePath}: ${cleanupError}`); 
                }
            }
          }
      }
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
    "MCP Image Uploader Server (wget & curl) v0.1.4 running on stdio. Waiting for requests..." 
  );
  console.error(`Using image upload URL from environment: ${IMAGE_UPLOAD_URL}`); 
  console.warn("This server requires 'wget', 'curl', and 'convert' (ImageMagick) to be installed and accessible in the system's PATH.");
}

main().catch((error) => {
  console.error("Server crashed:", error); 
  process.exit(1);
});

