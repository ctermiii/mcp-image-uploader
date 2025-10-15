# Changelog

## [0.2.0] - 2025-10-15

### Major Changes
- **Eliminated external dependencies on wget and curl**: Now uses native Node.js `http`/`https` modules for downloading and uploading images
- **Improved performance**: Native modules are faster and more reliable than spawning external processes
- **Better error handling**: Enhanced error messages and graceful error handling throughout the codebase
- **Reduced system requirements**: Only ImageMagick's `convert` is needed for WebP conversion (wget and curl no longer required)

### Improvements
- Added proper redirect handling for HTTP 301/302 responses
- Improved timeout handling for both download (15s) and upload (30s) operations
- Enhanced response parsing with support for more image host response formats
- Optimized file cleanup using parallel Promise operations
- Better TypeScript type safety throughout the codebase
- Cleaner console output with more informative messages

### Technical Details
- Replaced `wget` with native `https.get()` / `http.get()`
- Replaced `curl` with native `https.request()` / `http.request()` with multipart/form-data support
- Improved error handling with proper error types
- Used `Promise.all()` for parallel file cleanup operations

## [0.1.4] - Previous version
- Initial implementation using wget and curl
