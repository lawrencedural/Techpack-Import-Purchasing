# Columbia Purchasing Automation - PDF Data Extractor

A React-based web application for extracting and organizing data from PDF specification files.

## Features

- 📄 **Direct PDF Support**: Upload PDF files directly - no conversion needed!
- 🔍 **Smart Data Extraction**: Automatically detects and extracts:
  - Item numbers (6-digit codes)
  - Descriptions
  - Unit of measure (UM)
  - Fiber content
  - Material finish
  - Supplier information
  - Costs and lead times
- 📊 **Category Organization**: Automatically categorizes items into:
  - Fabrics
  - Trims
  - Packaging
- 💾 **CSV Export**: Export data to CSV for further processing
- 🎨 **Modern UI**: Clean, intuitive interface with Tailwind CSS

## Getting Started

### Installation

1. Install dependencies:
```bash
npm install
```

### Running the Application

2. Start the development server:
```bash
npm run dev
```

3. Open your browser and navigate to `http://localhost:5173`

### Building for Production

```bash
npm run build
```

## Usage

1. **Upload PDF File**: Simply upload your PDF specification file directly.
2. **Automatic Processing**: The tool will extract text from the PDF and parse all item data.
3. **View Results**: Data is automatically organized into Fabrics, Trims, and Packaging categories.
4. **Export Data**: Click "Export All" or export specific categories to CSV for further processing.

## How It Works

The application uses regex patterns and parsing logic to:
- Detect section headers (Fabric, Trim, Packaging)
- Extract 6-digit item numbers
- Parse descriptions and metadata
- Identify supplier information with costs and lead times
- Categorize items based on prefixes and unit of measure

## Technologies

- **React** - UI framework
- **Vite** - Build tool and dev server
- **Tailwind CSS** - Styling
- **Lucide React** - Icons
- **pdf.js** - PDF text extraction in the browser

## Project Structure

```
├── src/
│   ├── PDFDataExtractor.jsx  # Main component
│   ├── App.jsx                # App wrapper
│   ├── index.jsx              # Entry point
│   └── index.css              # Global styles
├── index.html                 # HTML template
├── package.json               # Dependencies
├── vite.config.js             # Vite configuration
├── tailwind.config.js         # Tailwind configuration
└── README.md                  # This file
```

## License

MIT
