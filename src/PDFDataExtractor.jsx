import React, { useState } from 'react';
import { Upload, Download, FileText, AlertCircle, CheckCircle, Info } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';

if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
}

const PDFDataExtractor = () => {
  const [file, setFile] = useState(null);
  const [extractedData, setExtractedData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('fabrics');
  const [validationStats, setValidationStats] = useState(null);
  const [rawText, setRawText] = useState(null);
  const [showRawText, setShowRawText] = useState(false);

  const handleFileUpload = async (event) => {
    const uploadedFile = event.target.files[0];
    if (!uploadedFile) {
      setError('Please upload a file');
      return;
    }

    setFile(uploadedFile);
    setError(null);
    setLoading(true);
    setValidationStats(null);

    try {
      const text = await readFileAsText(uploadedFile);
      setRawText(text);
      const parsedData = parseSpecificationData(text);
      const stats = validateParsedData(parsedData, text);
      setValidationStats(stats);
      setExtractedData(parsedData);
    } catch (err) {
      setError('Error parsing file: ' + err.message);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const readFileAsText = async (file) => {
    if (file.type === 'application/pdf') {
      return await extractTextFromPDF(file);
    } else {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsText(file);
      });
    }
  };

  const extractTextFromPDF = async (file) => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      let fullText = '';
      
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const lines = [];
        let lastY = -1;
        
        textContent.items.forEach(item => {
          const transform = item.transform || [1, 0, 0, 1, 0, 0];
          const y = transform[5];
          
          if (Math.abs(y - lastY) > 0.5) {
            lines.push([]);
            lastY = y;
          }
          
          if (lines.length > 0) {
            lines[lines.length - 1].push({
              text: item.str,
              x: transform[4]
            });
          }
        });
        
        const formattedLines = lines.map(line => {
          line.sort((a, b) => a.x - b.x);
          return line.map(item => item.text).join(' ');
        });
        
        fullText += formattedLines.join('\n') + '\n\n';
      }
      
      return fullText;
    } catch (error) {
      throw new Error('Failed to extract text from PDF: ' + error.message);
    }
  };

  const parseSpecificationData = (text) => {
    const fabrics = [];
    const trims = [];
    const lines = text.split('\n');
    let inFabricSection = false;
    let inTrimSection = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.includes('Fabric') && !line.includes('Width')) {
        inFabricSection = true;
        inTrimSection = false;
        continue;
      }
      
      if (line.includes('Trim') && !line.includes('Specific')) {
        inFabricSection = false;
        inTrimSection = true;
        continue;
      }

      const itemNumberMatch = line.match(/^(\d{6})\s+(.+)/);
      
      if (itemNumberMatch) {
        const itemNumber = itemNumberMatch[1];
        const contextData = getItemContextLines(lines, i);
        const itemData = extractItemDataFromLines(contextData, itemNumber);
        
        if (itemData) {
          if (inFabricSection || itemData.um === 'lb') {
            fabrics.push(itemData);
          } else if (inTrimSection || itemData.um === 'ea') {
            trims.push(itemData);
          }
        }
      }
    }

    return { 
      fabrics: deduplicateItems(fabrics), 
      trims: deduplicateItems(trims)
    };
  };

  const getItemContextLines = (lines, lineIndex) => {
    const start = Math.max(0, lineIndex - 5);
    const end = Math.min(lines.length, lineIndex + 15);
    return {
      lines: lines.slice(start, end),
      relativeIndex: lineIndex - start
    };
  };

  const extractItemDataFromLines = (contextData, itemNumber) => {
    const contextLines = contextData.lines;
    const relativeIndex = contextData.relativeIndex;
    const contextText = contextLines.join('\n');
    
    let description = '';
    
    if (relativeIndex < contextLines.length) {
      const itemLine = contextLines[relativeIndex];
      const descMatch = itemLine.match(new RegExp(`${itemNumber}\\s+(.+?)(?:\\s+(?:lb|ea)\\s|$)`));
      if (descMatch && descMatch[1]) {
        description = descMatch[1].trim().replace(/\s+\d+%.*$/, '').trim();
      }
    }
    
    if (!description || description.length < 3) {
      description = `Item ${itemNumber}`;
    }

    const umMatch = contextText.match(/\b(lb|ea)\b/);
    const um = umMatch ? umMatch[1] : 'ea';

    let fiberContent = 'unassigned';
    const fiberPatterns = [
      /\b(\d+%)\s*(?:Recycled\s+)?(Polyester|Acrylic|Nylon|Cotton|Polycarbonate|Plastic)(?:\s*,\s*(\d+%)\s*(?:Recycled\s+)?(Polyester|Acrylic|Nylon|Cotton|Polycarbonate|Plastic))?/
    ];
    
    for (const pattern of fiberPatterns) {
      const match = contextText.match(pattern);
      if (match) {
        if (match[3] && match[4]) {
          fiberContent = `${match[1]} ${match[2]}, ${match[3]} ${match[4]}`;
        } else if (match[2]) {
          fiberContent = `${match[1]} ${match[2]}`;
        }
        break;
      }
    }

    let materialFinish = 'unassigned';
    const finishPatterns = [/\b(Yarn\s+Dye[d]?)/i, /\b(Piece\s+Dye[d]?)/i];
    
    for (const pattern of finishPatterns) {
      const match = contextText.match(pattern);
      if (match) {
        materialFinish = match[1];
        break;
      }
    }

    const trimMatch = contextText.match(/Size\s+UM:\s*(mm|cm|ea|in)/i);
    const trimSpecific = trimMatch ? `Size UM: ${trimMatch[1]}` : '';
    const suppliers = extractSuppliersFromLines(contextLines, relativeIndex);

    return {
      number: itemNumber,
      description,
      um,
      fiberContent,
      materialFinish,
      trimSpecific,
      suppliers
    };
  };

  const extractSuppliersFromLines = (contextLines, currentIndex) => {
    const suppliers = [];
    
    for (let i = currentIndex + 1; i < Math.min(contextLines.length, currentIndex + 10); i++) {
      const line = contextLines[i];
      if (/^\d{6}\s/.test(line.trim())) break;
      
      let foundSupplier = null;
      
      if (line.includes('Nexgen') && line.includes('Packaging')) {
        foundSupplier = 'Nexgen Packaging Global';
      } else if (line.includes('Avery') && line.includes('Dennison')) {
        foundSupplier = 'Avery Dennison Global';
      } else if (line.includes('Bao Shen')) {
        foundSupplier = 'Bao Shen (Apparel)';
      } else if (line.includes('Hang Sang Press')) {
        foundSupplier = 'Hang Sang Press Co. Ltd';
      } else if (line.includes('Finotex El Salvador')) {
        foundSupplier = 'Finotex El Salvador';
      } else if (line.includes('Manohar Filaments')) {
        foundSupplier = 'Manohar Filaments';
      } else if (line.includes('Texpak')) {
        foundSupplier = 'Texpak';
      } else if (line.includes('FGV Sourced')) {
        foundSupplier = 'FGV Sourced';
      } else if (line.includes('Hang Sang')) {
        foundSupplier = 'Hang Sang Press Co. Ltd';
      } else if (line.trim() === 'Contractor' || line.startsWith('Contractor ')) {
        foundSupplier = 'Contractor';
      } else if (line.includes('FGV')) {
        const fgvMatch = line.match(/FGV[^a-z\n]*([A-Z][a-z]+\s+[A-Z][a-z]+)/);
        foundSupplier = fgvMatch ? `FGV - ${fgvMatch[1]}` : line.substring(0, 40).trim();
      } else {
        const patterns = [
          /^([A-Z][A-Za-z\s\-()\.]{8,}(?:Global|Ltd|Inc|Apparel|MSO|Sourced|Contractor|Era|Kewalram|Packaging|Dennison|Enterprises|Group|Manufacturing|Trading))/,
          /^([A-Z][A-Za-z\s]+(?:Co\.|Corp|Company|Filaments))/
        ];
        
        for (const pattern of patterns) {
          const match = line.match(pattern);
          if (match) {
            foundSupplier = match[1].trim();
            if (foundSupplier.length >= 6 && foundSupplier.length < 80) break;
          }
        }
      }
      
      if (foundSupplier) {
        const numbers = line.match(/\d+\.?\d*/g) || [];
        const costs = numbers.filter(n => parseFloat(n) >= 0.001 && parseFloat(n) <= 10.0);
        const cost = costs.length > 0 ? parseFloat(costs[0]) : 0;
        const leadTimes = numbers.filter(n => {
          const num = parseInt(n);
          return num >= 0 && num <= 120 && !n.includes('.');
        });
        const countryMatch = line.match(/(China|Vietnam|USA|Hong Kong|El Salvador|India|Canada|Mexico|Bangladesh|Thailand|Indonesia|Pakistan|Cambodia|Haiti|Guatemala)/);
        const country = countryMatch ? countryMatch[1] : 'unassigned';
        const artNoMatch = line.match(/(\d{6}|TBD|n\/a)/);
        let artNo = artNoMatch ? artNoMatch[1] : 'TBD';
        
        suppliers.push({
          name: foundSupplier,
          artNo,
          country,
          stdCost: cost,
          purCost: 0.0,
          leadWithGreige: leadTimes.length >= 2 ? parseInt(leadTimes[leadTimes.length - 2]) : (leadTimes.length > 0 ? parseInt(leadTimes[0]) : 0),
          leadWithoutGreige: leadTimes.length >= 2 ? parseInt(leadTimes[leadTimes.length - 1]) : (leadTimes.length > 1 ? parseInt(leadTimes[1]) : 0)
        });
      }
    }

    return suppliers;
  };

  const deduplicateItems = (items) => {
    const seen = new Set();
    return items.filter(item => {
      if (seen.has(item.number)) return false;
      seen.add(item.number);
      return true;
    });
  };

  const validateParsedData = (parsedData, fullText) => {
    const stats = {
      totalItems: parsedData.fabrics.length + parsedData.trims.length,
      itemsWithSuppliers: 0,
      itemsWithoutSuppliers: 0,
      itemsWithUnassignedFields: 0,
      issues: [],
      warnings: []
    };

    const allItems = [...parsedData.fabrics, ...parsedData.trims];
    
    allItems.forEach(item => {
      if (item.suppliers.length === 0) {
        stats.itemsWithoutSuppliers++;
      } else {
        stats.itemsWithSuppliers++;
      }

      if (item.fiberContent === 'unassigned' || item.materialFinish === 'unassigned') {
        stats.itemsWithUnassignedFields++;
      }

      if (!item.description || item.description === `Item ${item.number}`) {
        stats.warnings.push({
          itemNumber: item.number,
          issue: 'Description missing or incomplete',
          severity: 'high'
        });
      }

      item.suppliers.forEach(supplier => {
        if (!supplier.country || supplier.country === 'unassigned') {
          stats.warnings.push({
            itemNumber: item.number,
            issue: 'Missing country for supplier',
            severity: 'medium'
          });
        }
        
        if (!supplier.stdCost || supplier.stdCost === 0) {
          stats.warnings.push({
            itemNumber: item.number,
            issue: 'Missing or zero cost data',
            severity: 'high'
          });
        }
      });
    });

    const totalChecks = allItems.length * 4;
    const passedChecks = 
      allItems.filter(item => item.description && item.description !== `Item ${item.number}`).length +
      allItems.filter(item => item.suppliers.length > 0).length +
      allItems.filter(item => item.fiberContent !== 'unassigned').length;
    
    stats.confidenceScore = Math.round((passedChecks / totalChecks) * 100);
    stats.warningsCount = stats.warnings.length;
    stats.issuesCount = stats.issues.length;

    return stats;
  };

  const exportToCSV = (data, filename) => {
    let csv = '';
    const headers = ['Number', 'Description', 'UM', 'Fiber Content', 'Material Finish', 'Trim Specific', 'Supplier Name', 'Supplier Art No', 'Country of Origin', 'Standard Cost (FOB)', 'Purchase Cost (CIF)', 'Lead Time with Greige', 'Lead Time without Greige'];
    csv += headers.join(',') + '\n';
    
    data.forEach(item => {
      if (item.suppliers.length === 0) {
        const row = [item.number, `"${item.description.replace(/"/g, '""')}"`, item.um, `"${item.fiberContent.replace(/"/g, '""')}"`, item.materialFinish, `"${item.trimSpecific || ''}"`, '', '', '', '', '', '', ''];
        csv += row.join(',') + '\n';
      } else {
        item.suppliers.forEach(supplier => {
          const row = [item.number, `"${item.description.replace(/"/g, '""')}"`, item.um, `"${item.fiberContent.replace(/"/g, '""')}"`, item.materialFinish, `"${item.trimSpecific || ''}"`, `"${supplier.name.replace(/"/g, '""')}"`, supplier.artNo, supplier.country, supplier.stdCost, supplier.purCost, supplier.leadWithGreige, supplier.leadWithoutGreige];
          csv += row.join(',') + '\n';
        });
      }
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  };

  const exportToTemplateFormat = (data, filename) => {
    let csv = '';
    const headers = [
      'Main Label', 'Main Label Color', 'Supplier', 'Additional Main Label', 'Main Label Color', 'Supplier',
      'Care Label', 'Care Label Color', 'Supplier', 'Content Code', 'TP FC', 'Care Code', 'Hangtag',
      'Supplier', 'Hangtag', 'Supplier', 'RFID Sticker', 'Supplier', 'UPC Sticker (Polybag)', 'Supplier'
    ];
    csv += headers.join(',') + '\n';
    
    data.forEach(item => {
      if (item.suppliers.length === 0) {
        // Empty row for items without suppliers
        const row = new Array(headers.length).fill('');
        csv += row.join(',') + '\n';
      } else {
        item.suppliers.forEach(supplier => {
          const row = new Array(headers.length).fill('');
          
          // Map data to template columns based on item type
          if (item.description.toLowerCase().includes('label') || 
              item.description.toLowerCase().includes('woven')) {
            // Main Label data
            row[0] = `"${item.description.replace(/"/g, '""')}"`;
            row[1] = ''; // Color - to be filled manually
            row[2] = `"${supplier.name.replace(/"/g, '""')}"`;
          } else if (item.description.toLowerCase().includes('care')) {
            // Care Label data
            row[6] = `"${item.description.replace(/"/g, '""')}"`;
            row[7] = ''; // Color - to be filled manually
            row[8] = `"${supplier.name.replace(/"/g, '""')}"`;
          } else if (item.description.toLowerCase().includes('hangtag') || 
                     item.description.toLowerCase().includes('hang tag')) {
            // Hangtag data
            row[12] = `"${item.description.replace(/"/g, '""')}"`;
            row[13] = `"${supplier.name.replace(/"/g, '""')}"`;
          } else if (item.description.toLowerCase().includes('sticker') || 
                     item.description.toLowerCase().includes('upc')) {
            // UPC Sticker data
            row[18] = `"${item.description.replace(/"/g, '""')}"`;
            row[19] = `"${supplier.name.replace(/"/g, '""')}"`;
          } else if (item.description.toLowerCase().includes('rfid')) {
            // RFID Sticker data
            row[16] = `"${item.description.replace(/"/g, '""')}"`;
            row[17] = `"${supplier.name.replace(/"/g, '""')}"`;
          } else {
            // Default to Main Label for unclassified items
            row[0] = `"${item.description.replace(/"/g, '""')}"`;
            row[2] = `"${supplier.name.replace(/"/g, '""')}"`;
          }
          
          csv += row.join(',') + '\n';
        });
      }
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  };

  const renderTable = (data) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Number</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Description</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">UM</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Fiber Content</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Material Finish</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Supplier</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Country</th>
            <th className="border border-gray-300 px-2 py-2 text-right font-semibold">Std Cost</th>
            <th className="border border-gray-300 px-2 py-2 text-right font-semibold">Lead Time</th>
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan="9" className="border border-gray-300 px-4 py-8 text-center text-gray-500">
                No data found. Please upload a specification file.
              </td>
            </tr>
          ) : (
            data.map((item, idx) => (
              item.suppliers.length === 0 ? (
                <tr key={idx} className="hover:bg-gray-50">
                  <td className="border border-gray-300 px-2 py-2">{item.number}</td>
                  <td className="border border-gray-300 px-2 py-2">{item.description}</td>
                  <td className="border border-gray-300 px-2 py-2">{item.um}</td>
                  <td className="border border-gray-300 px-2 py-2">{item.fiberContent}</td>
                  <td className="border border-gray-300 px-2 py-2">{item.materialFinish}</td>
                  <td className="border border-gray-300 px-2 py-2 text-gray-400" colSpan="4">No suppliers found</td>
                </tr>
              ) : (
                item.suppliers.map((supplier, sIdx) => (
                  <tr key={`${idx}-${sIdx}`} className="hover:bg-gray-50">
                    {sIdx === 0 && (
                      <>
                        <td className="border border-gray-300 px-2 py-2" rowSpan={item.suppliers.length}>{item.number}</td>
                        <td className="border border-gray-300 px-2 py-2" rowSpan={item.suppliers.length}>{item.description}</td>
                        <td className="border border-gray-300 px-2 py-2" rowSpan={item.suppliers.length}>{item.um}</td>
                        <td className="border border-gray-300 px-2 py-2" rowSpan={item.suppliers.length}>{item.fiberContent}</td>
                        <td className="border border-gray-300 px-2 py-2" rowSpan={item.suppliers.length}>{item.materialFinish}</td>
                      </>
                    )}
                    <td className="border border-gray-300 px-2 py-2">{supplier.name}</td>
                    <td className="border border-gray-300 px-2 py-2">{supplier.country}</td>
                    <td className="border border-gray-300 px-2 py-2 text-right">${supplier.stdCost.toFixed(4)}</td>
                    <td className="border border-gray-300 px-2 py-2 text-right">{supplier.leadWithoutGreige} days</td>
                  </tr>
                ))
              )
            ))
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">PDF Data Extractor</h1>
              <p className="text-gray-600 mt-1">Upload specification file to extract Fabrics and Trims</p>
            </div>
            <FileText className="w-12 h-12 text-blue-600" />
          </div>

          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg flex items-start gap-3">
            <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-blue-900 mb-1">How to use:</p>
              <ol className="list-decimal ml-5 text-blue-800">
                <li>Upload your PDF specification file</li>
                <li>Tool extracts items with 6-digit numbers automatically</li>
                <li>Gray rows (items) and white rows (suppliers) parsed together</li>
                <li>Export results to CSV for further use</li>
              </ol>
            </div>
          </div>

          <div className="mb-6">
            <label className="flex flex-col items-center justify-center w-full h-48 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <Upload className="w-12 h-12 text-gray-400 mb-3" />
                <p className="mb-2 text-sm text-gray-500">
                  <span className="font-semibold">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-gray-500">PDF files (.pdf) or text files (.txt)</p>
                {file && (
                  <p className="mt-2 text-sm text-green-600 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4" />
                    {file.name}
                  </p>
                )}
              </div>
              <input type="file" className="hidden" accept=".pdf,.txt" onChange={handleFileUpload} />
            </label>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
              <p className="ml-4 text-gray-600">Extracting and parsing data...</p>
            </div>
          )}

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-red-900">Error</h3>
                <p className="text-red-700 text-sm">{error}</p>
              </div>
            </div>
          )}

          {extractedData && !loading && (
            <>
              <div className="flex gap-2 mb-6 border-b">
                <button
                  onClick={() => setActiveTab('fabrics')}
                  className={`px-4 py-2 font-medium transition-colors ${activeTab === 'fabrics' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Fabrics ({extractedData.fabrics.length})
                </button>
                <button
                  onClick={() => setActiveTab('trims')}
                  className={`px-4 py-2 font-medium transition-colors ${activeTab === 'trims' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Trims ({extractedData.trims.length})
                </button>
              </div>

              <div className="mb-4 flex justify-end gap-2">
                <button
                  onClick={() => exportToTemplateFormat([...extractedData.fabrics, ...extractedData.trims], 'template_filled.csv')}
                  className="flex items-center gap-2 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Export to Template
                </button>
                <button
                  onClick={() => exportToCSV([...extractedData.fabrics, ...extractedData.trims], 'all_items_data.csv')}
                  className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Export All Data
                </button>
                <button
                  onClick={() => {
                    const data = activeTab === 'fabrics' ? extractedData.fabrics : extractedData.trims;
                    exportToCSV(data, `${activeTab}_data.csv`);
                  }}
                  className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Export {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
                </button>
                <button
                  onClick={() => setShowRawText(!showRawText)}
                  className="flex items-center gap-2 bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700 transition-colors"
                >
                  <FileText className="w-4 h-4" />
                  {showRawText ? 'Hide' : 'View'} Raw Text
                </button>
              </div>

              {showRawText && rawText && (
                <div className="mb-6 p-4 bg-gray-900 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="text-white font-semibold">Raw Extracted Text</h3>
                    <button
                      onClick={() => {
                        const blob = new Blob([rawText], { type: 'text/plain' });
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'extracted_text.txt';
                        a.click();
                      }}
                      className="text-gray-300 hover:text-white text-sm flex items-center gap-1"
                    >
                      <Download className="w-4 h-4" />
                      Download
                    </button>
                  </div>
                  <pre className="text-xs text-gray-300 overflow-auto max-h-96 p-4 bg-black rounded">
                    {rawText.substring(0, 5000)}{rawText.length > 5000 ? '\n\n... (truncated)' : ''}
                  </pre>
                </div>
              )}

              {activeTab === 'fabrics' && renderTable(extractedData.fabrics)}
              {activeTab === 'trims' && renderTable(extractedData.trims)}

              <div className="mt-6 space-y-4">
                <div className="p-4 bg-green-50 rounded-lg">
                  <h3 className="font-semibold text-gray-900 mb-2">✓ Extraction Complete</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div><span className="font-medium">Fabrics:</span> {extractedData.fabrics.length} items</div>
                    <div><span className="font-medium">Trims:</span> {extractedData.trims.length} items</div>
                  </div>
                </div>

                {validationStats && (
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                        <Info className="w-5 h-5 text-blue-600" />
                        Data Validation
                      </h3>
                      <div className={`px-3 py-1 rounded-full font-semibold ${
                        validationStats.confidenceScore >= 80 ? 'bg-green-100 text-green-700' :
                        validationStats.confidenceScore >= 60 ? 'bg-yellow-100 text-yellow-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        Confidence: {validationStats.confidenceScore}%
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-4 gap-4 text-sm">
                      <div><span className="font-medium">Total Items:</span> {validationStats.totalItems}</div>
                      <div>
                        <span className="font-medium">With Suppliers:</span> 
                        <span className="text-green-600 ml-1">{validationStats.itemsWithSuppliers}</span>
                      </div>
                      <div>
                        <span className="font-medium">Without Suppliers:</span> 
                        <span className="text-red-600 ml-1">{validationStats.itemsWithoutSuppliers}</span>
                      </div>
                      <div>
                        <span className="font-medium">Unassigned Fields:</span> 
                        <span className="text-yellow-600 ml-1">{validationStats.itemsWithUnassignedFields}</span>
                      </div>
                    </div>

                    {validationStats.warnings.length > 0 && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-sm font-medium text-gray-700 hover:text-gray-900">
                          {validationStats.warnings.length} Warnings Found
                        </summary>
                        <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
                          {validationStats.warnings.slice(0, 10).map((warning, idx) => (
                            <div key={idx} className={`text-xs p-2 rounded ${
                              warning.severity === 'high' ? 'bg-yellow-100' : 'bg-blue-100'
                            }`}>
                              <span className={`font-semibold ${
                                warning.severity === 'high' ? 'text-yellow-700' : 'text-blue-700'
                              }`}>
                                Item {warning.itemNumber}:
                              </span>
                              <span className={`ml-2 ${
                                warning.severity === 'high' ? 'text-yellow-600' : 'text-blue-600'
                              }`}>
                                {warning.issue}
                              </span>
                            </div>
                          ))}
                          {validationStats.warnings.length > 10 && (
                            <p className="text-xs text-gray-600 italic">
                              ... and {validationStats.warnings.length - 10} more warnings
                            </p>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default PDFDataExtractor;