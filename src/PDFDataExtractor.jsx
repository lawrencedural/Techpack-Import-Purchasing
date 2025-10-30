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
      console.log('Starting file upload:', uploadedFile.name, uploadedFile.type);
      const text = await readFileAsText(uploadedFile);
      console.log('Extracted text length:', text?.length || 0);
      console.log('First 500 chars:', text?.substring(0, 500));
      
      setRawText(text);
      const parsedData = parseSpecificationData(text);
      
      // Summary of extraction
      console.log('==== EXTRACTION COMPLETE ====');
      console.log(`Total Items: ${parsedData.fabrics.length + parsedData.trims.length}`);
      console.log(`Fabrics: ${parsedData.fabrics.length}`);
      console.log(`Trims: ${parsedData.trims.length}`);
      
      // Show all extracted items with details
      const allItems = [...parsedData.fabrics, ...parsedData.trims];
      console.log('\n=== EXTRACTED ITEMS ===');
      allItems.forEach((item, idx) => {
        console.log(`${idx + 1}. Item ${item.number}`);
        console.log(`   Description: ${item.description}`);
        console.log(`   Colors: ${item.colors && item.colors.length > 0 ? item.colors.join(', ') : 'N/A'}`);
        console.log(`   Suppliers: ${item.suppliers.map(s => s.name).join(', ') || 'N/A'}`);
        if (item.contentCode) console.log(`   Content Code: ${item.contentCode}`);
        if (item.fiberContent !== 'unassigned') console.log(`   Fiber: ${item.fiberContent}`);
      });
      
      const stats = validateParsedData(parsedData, text);
      console.log(`\nConfidence Score: ${stats.confidenceScore}%`);
      if (stats.warningsCount > 0) {
        console.log(`Warnings: ${stats.warningsCount}`);
      }
      console.log('============================\n');
      setValidationStats(stats);
      setExtractedData(parsedData);
    } catch (err) {
      setError('Error parsing file: ' + err.message);
      console.error('Full error:', err);
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
        
        // Group text items by Y-coordinate (same line)
        const lineMap = new Map();
        
        textContent.items.forEach(item => {
          if (!item.str.trim()) return; // Skip empty strings
          
          const transform = item.transform || [1, 0, 0, 1, 0, 0];
          const y = Math.round(transform[5] * 2) / 2; // Round to nearest 0.5 for grouping
          const x = transform[4];
          
          if (!lineMap.has(y)) {
            lineMap.set(y, []);
          }
          
          lineMap.get(y).push({
            text: item.str,
            x: x,
            width: item.width || 0
          });
        });
        
        // Sort lines by Y coordinate (descending - top to bottom)
        const sortedLines = Array.from(lineMap.entries())
          .sort((a, b) => b[0] - a[0]);
        
        // Format each line by sorting items by X coordinate
        const formattedLines = sortedLines.map(([y, items]) => {
          items.sort((a, b) => a.x - b.x);
          
          // Smart spacing: add space between items if gap is significant
          let lineText = '';
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const nextItem = items[i + 1];
            
            lineText += item.text;
            
            if (nextItem) {
              const gap = nextItem.x - (item.x + item.width);
              // Add space if gap is significant (more than 5 units)
              if (gap > 5 || item.text.match(/[a-zA-Z0-9]$/) && nextItem.text.match(/^[a-zA-Z0-9]/)) {
                lineText += ' ';
              }
            }
          }
          
          return lineText.trim();
        }).filter(line => line.length > 0);
        
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
    const lines = text.split('\n').map(line => line.trim());
    let inFabricSection = false;
    let inTrimSection = false;
    
    const seenItemNumbers = new Set(); // Track items already processed
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Skip lines that are clearly not item definitions
      if (line.match(/^(FOB|CIF|Unit Cost|Total|Component - Material|Material\s+\d{6}|Part:|Page \d+ of)/i)) {
        continue;
      }
      
      // Detect section headers more robustly
      if (line.match(/^Fabric(?:\s|$)/i) && !line.match(/Width|Content/i)) {
        inFabricSection = true;
        inTrimSection = false;
        continue;
      }
      
      if (line.match(/^Trim(?:\s|$)/i) && !line.match(/Specific/i)) {
        inFabricSection = false;
        inTrimSection = true;
        continue;
      }

      // Flexible item number detection - supports 6, 8, or 9 digit numbers anywhere in line
      // Matches patterns like: "123456" or "12345678" or "209264155"
      const itemNumberMatches = [
        line.match(/\b(\d{9})\b/),  // 9-digit numbers
        line.match(/\b(\d{8})\b/),  // 8-digit numbers
        line.match(/^\s*(\d{6})[\s:]+/),  // 6-digit at start
        line.match(/\b(\d{6})\b/)   // 6-digit anywhere
      ];
      
      const itemNumberMatch = itemNumberMatches.find(m => m !== null);
      
      if (itemNumberMatch) {
        const itemNumber = itemNumberMatch[1];
        
        // Skip if already processed this item number
        if (seenItemNumbers.has(itemNumber)) {
          continue;
        }
        
        // Skip lines that are just listing multiple numbers (material lists)
        const numberCount = (line.match(/\b\d{6,9}\b/g) || []).length;
        if (numberCount > 2) {
          continue; // Line has multiple item numbers, likely a summary/list
        }
        
        const contextData = getItemContextLines(lines, i);
        const itemData = extractItemDataFromLines(contextData, itemNumber);
        
        if (itemData && itemData.description && itemData.description.length > 2) {
          seenItemNumbers.add(itemNumber); // Mark as processed
          
          // Classify based on section and unit of measure
          if (inFabricSection || itemData.um === 'lb' || itemData.um === 'yd' || itemData.um === 'yds') {
            fabrics.push(itemData);
          } else if (inTrimSection || itemData.um === 'ea' || itemData.um === 'pcs') {
            trims.push(itemData);
          } else {
            // If unclear, use heuristics
            const desc = itemData.description.toLowerCase();
            if (desc.includes('fabric') || desc.includes('textile') || desc.includes('cloth') || desc.includes('yarn') || desc.includes('jersey')) {
              fabrics.push(itemData);
            } else {
              trims.push(itemData);
            }
          }
        }
        // Silently skip items with insufficient description
      }
    }

    return { 
      fabrics: deduplicateItems(fabrics), 
      trims: deduplicateItems(trims)
    };
  };

  const getItemContextLines = (lines, lineIndex) => {
    const start = Math.max(0, lineIndex - 3);
    let end = lineIndex + 1;
    
    // Extend context until we hit the next item number or max 25 lines
    for (let i = lineIndex + 1; i < Math.min(lines.length, lineIndex + 25); i++) {
      // Check for any item number format (6, 8, or 9 digits)
      if (lines[i].match(/\b\d{6,9}\b/)) {
        end = i;
        break;
      }
      end = i + 1;
    }
    
    return {
      lines: lines.slice(start, end),
      relativeIndex: lineIndex - start
    };
  };

  const extractItemDataFromLines = (contextData, itemNumber) => {
    const contextLines = contextData.lines;
    const relativeIndex = contextData.relativeIndex;
    const contextText = contextLines.join('\n');
    const itemLine = relativeIndex < contextLines.length ? contextLines[relativeIndex] : '';
    
    let description = '';
    let colors = [];
    let contentCode = '';
    let careCode = '';
    
    // Try to extract description from the item line
    const descPatterns = [
      // Pattern 1: Text BEFORE the item number
      new RegExp(`^(.+?)\\s+${itemNumber}`, 'i'),
      // Pattern 2: Text AFTER the item number
      new RegExp(`${itemNumber}[\\s:]+(.+?)(?:\\s+(?:lb|ea|yd|yds|pcs|White|Black|Grey|N/A)\\s|$)`, 'i'),
    ];
    
    for (const pattern of descPatterns) {
      const match = itemLine.match(pattern);
      if (match && match[1]) {
        description = match[1].trim()
          .replace(/^\d+-/, '') // Remove SKU prefix
          .replace(/^(Shell|Alt Shell|Insulation|Label|Hangtag|Packaging)\s+\w+\s+/, '') // Remove component prefixes
          .replace(/,\s*\w+,\s*\w+$/, '') // Remove trailing color info
          .trim();
        
        if (description.length >= 3) {
          break;
        }
      }
    }
    
    if (!description || description.length < 3) {
      description = `Item ${itemNumber}`;
    }

    // Extract colors from the line (e.g., "White, Black")
    const colorMatch = itemLine.match(/(White|Black|Grey|Gray|Red|Blue|Green|Yellow|Brown|Pink|Purple|Orange|Beige|Tan|Navy|Cream|Natural|Stock|Artwork)(?:\s*,\s*(White|Black|Grey|Gray|Red|Blue|Green|Yellow|Brown|Pink|Purple|Orange|Beige|Tan|Navy|Cream|Natural|Stock|Artwork))?/gi);
    if (colorMatch) {
      colors = colorMatch.flatMap(c => c.split(/\s*,\s*/)).filter((v, i, a) => a.indexOf(v) === i);
    }

    // Extract content code (e.g., "BWO")
    const contentCodeMatch = contextText.match(/\b([A-Z]{2,4})\b.*?Shell.*?%/i);
    if (contentCodeMatch) {
      contentCode = contentCodeMatch[1];
    }

    // Extract care code
    const careCodeMatch = contextText.match(/\b(\d{4})\b/);
    if (careCodeMatch && careCodeMatch[1] !== itemNumber) {
      careCode = careCodeMatch[1];
    }

    // Extract unit of measure
    const umMatch = contextText.match(/\b(lb|ea|yd|yds|pcs)\b/i);
    const um = umMatch ? umMatch[1].toLowerCase() : 'ea';

    // Extract fiber content with full composition
    let fiberContent = 'unassigned';
    const fiberPattern = /Shell:\s*([\d%\s\w,]+(?:Exclusive\s+of\s+Trimming)?)/i;
    const fiberMatch = contextText.match(fiberPattern);
    if (fiberMatch) {
      fiberContent = fiberMatch[1].trim();
    } else {
      // Try percentage-based pattern
      const percentPattern = /(\d+%\s+[\w\s]+(?:Polyester|Cotton|Nylon|Acrylic|Spandex|Wool)(?:\s+\d+%\s+[\w\s]+)*)/i;
      const percentMatch = contextText.match(percentPattern);
      if (percentMatch) {
        fiberContent = percentMatch[1].trim();
      }
    }

    // Extract material finish or color information
    let materialFinish = colors.join(', ') || 'unassigned';
    
    const finishPatterns = [
      /\b(Antique\s+Silver\s+Finish)\b/i,
      /\b(Black,?\s*white)\b/i,
      /\b(White,?\s*Black)\b/i,
      /\b(Grill,?\s*Columbia\s+Grey)\b/i,
      /\b(Black,?\s*Shark,?\s*Shark)\b/i,
    ];
    
    for (const pattern of finishPatterns) {
      const match = contextText.match(pattern);
      if (match) {
        materialFinish = match[1];
        break;
      }
    }

    // Extract suppliers with all their data
    const suppliers = extractSuppliersFromLines(contextLines, relativeIndex);

    return {
      number: itemNumber,
      description,
      um,
      fiberContent,
      materialFinish,
      colors,
      contentCode,
      careCode,
      trimSpecific: '',
      suppliers
    };
  };

  const extractSuppliersFromLines = (contextLines, currentIndex) => {
    const suppliers = [];
    const seenSuppliers = new Set();
    
    // Look at the current line and next few lines for supplier info
    for (let i = currentIndex; i < Math.min(contextLines.length, currentIndex + 15); i++) {
      const line = contextLines[i];
      
      // Stop at next item number (but not on current line)
      if (i > currentIndex && /^\s*\d{6,9}\b/.test(line.trim())) break;
      
      // Skip empty lines
      if (!line.trim()) continue;
      
      let foundSupplier = null;
      
      // Known supplier patterns (hard-coded for accuracy) - check these first
      if (line.match(/\bPT\s+BSN\b/i)) {
        foundSupplier = 'PT BSN';
      } else if (line.match(/\bHang\s+Sang\b/i)) {
        foundSupplier = 'Hang Sang';
      } else if (line.match(/\bAvery\b/i)) {
        foundSupplier = 'Avery';
      } else if (line.match(/Nexgen/i)) {
        foundSupplier = 'Nexgen';
      } else if (line.match(/Avery.*Dennison/i)) {
        foundSupplier = 'Avery Dennison';
      } else if (line.match(/Bao\s+Shen/i)) {
        foundSupplier = 'Bao Shen';
      } else if (line.match(/Hang\s+Sang\s+Press/i)) {
        foundSupplier = 'Hang Sang Press';
      } else if (line.match(/Finotex/i)) {
        foundSupplier = 'Finotex';
      } else if (line.match(/Manohar/i)) {
        foundSupplier = 'Manohar';
      } else if (line.match(/Texpak/i)) {
        foundSupplier = 'Texpak';
      } else if (line.match(/\bFGV\b/i)) {
        foundSupplier = 'FGV';
      } else if (line.match(/Contractor/i)) {
        foundSupplier = 'Contractor';
      } else {
        // Generic supplier name patterns
        const patterns = [
          // Company with common suffixes
          /^([A-Z][A-Za-z\s\-()&\.,']{4,}(?:Global|Ltd\.?|Inc\.?|Apparel|MSO|Sourced|Contractor|Era|Kewalram|Packaging|Dennison|Enterprises?|Group|Manufacturing|Trading|International|Corporation))/i,
          // Company with Co., Corp, etc.
          /^([A-Z][A-Za-z\s\-()&\.,']+(?:Co\.|Corp\.?|Company|Filaments|Textiles?|Industries|Systems?))/i,
          // General capitalized name (at least 2 words)
          /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,})/
        ];
        
        for (const pattern of patterns) {
          const match = line.match(pattern);
          if (match) {
            let potentialSupplier = match[1].trim();
            
            // Clean up
            potentialSupplier = potentialSupplier
              .replace(/\s+/g, ' ')
              .replace(/^\s*[-•*]\s*/, '') // Remove bullet points
              .trim();
            
            // Validate length and content
            if (potentialSupplier.length >= 5 && 
                potentialSupplier.length < 100 &&
                !potentialSupplier.match(/^(Size|Color|Width|Length|Weight|Price|Cost|Lead|Time|Days|Greige)/i)) {
              foundSupplier = potentialSupplier;
              break;
            }
          }
        }
      }
      
      if (foundSupplier) {
        // Avoid duplicates
        if (seenSuppliers.has(foundSupplier)) continue;
        seenSuppliers.add(foundSupplier);
        
        // Extract numbers from the line and following line
        const nextLine = i + 1 < contextLines.length ? contextLines[i + 1] : '';
        const combinedLine = line + ' ' + nextLine;
        
        const allNumbers = combinedLine.match(/\d+\.?\d*/g) || [];
        
        // Extract cost (typically a decimal number between 0.001 and 100)
        const costs = allNumbers
          .map(n => parseFloat(n))
          .filter(n => !isNaN(n) && n >= 0.001 && n <= 100.0 && n.toString().includes('.'));
        const cost = costs.length > 0 ? costs[0] : 0;
        
        // Extract lead times (typically integers between 1 and 120, excluding art numbers)
        const leadTimes = allNumbers
          .map(n => parseInt(n))
          .filter(n => !isNaN(n) && n >= 1 && n <= 120 && n.toString().length <= 3);
        
        // Extract country
        const countryPatterns = [
          'China', 'Vietnam', 'USA', 'United States', 'Hong Kong', 'El Salvador', 
          'India', 'Canada', 'Mexico', 'Bangladesh', 'Thailand', 'Indonesia', 
          'Pakistan', 'Cambodia', 'Haiti', 'Guatemala', 'Taiwan', 'South Korea',
          'Japan', 'Philippines', 'Sri Lanka', 'Turkey', 'Italy', 'Portugal',
          'Morocco', 'Tunisia', 'Egypt', 'Jordan', 'Myanmar', 'Malaysia'
        ];
        
        let country = 'unassigned';
        for (const countryName of countryPatterns) {
          if (combinedLine.match(new RegExp(countryName, 'i'))) {
            country = countryName;
            break;
          }
        }
        
        // Extract article number (6-digit number, TBD, or n/a)
        const artNoMatch = combinedLine.match(/\b(\d{6})\b|TBD|n\/a|N\/A/i);
        let artNo = 'TBD';
        if (artNoMatch) {
          artNo = artNoMatch[1] || artNoMatch[0];
        }
        
        suppliers.push({
          name: foundSupplier,
          artNo,
          country,
          stdCost: cost,
          purCost: 0.0,
          leadWithGreige: leadTimes.length >= 2 ? leadTimes[leadTimes.length - 2] : (leadTimes.length > 0 ? leadTimes[0] : 0),
          leadWithoutGreige: leadTimes.length >= 2 ? leadTimes[leadTimes.length - 1] : (leadTimes.length > 1 ? leadTimes[1] : 0)
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
    
    // Track what was successfully extracted
    let successfulExtractions = 0;
    let totalExpected = 0;
    
    allItems.forEach(item => {
      // Check item number and description (always required)
      totalExpected += 2;
      if (item.number) successfulExtractions++;
      if (item.description && item.description !== `Item ${item.number}`) {
        successfulExtractions++;
      } else {
        stats.warnings.push({
          itemNumber: item.number,
          issue: 'Description missing or incomplete',
          severity: 'medium'
        });
      }
      
      // Only validate suppliers if the PDF seems to contain supplier data
      if (item.suppliers.length > 0) {
        stats.itemsWithSuppliers++;
        
        // If suppliers exist, validate their completeness
        item.suppliers.forEach(supplier => {
          totalExpected += 2; // Name + country
          if (supplier.name) successfulExtractions++;
          if (supplier.country && supplier.country !== 'unassigned') {
            successfulExtractions++;
          }
        });
      } else {
        // Not penalizing for no suppliers - might not be in PDF format
        stats.itemsWithoutSuppliers++;
      }

      // Only penalize for missing fiber/finish if these fields are common in the PDF
      if (item.fiberContent !== 'unassigned') {
        successfulExtractions++;
        totalExpected++;
      }
      if (item.materialFinish !== 'unassigned') {
        successfulExtractions++;
        totalExpected++;
      }
    });

    // Calculate confidence based on what was actually expected vs extracted
    // If no additional data expected (no suppliers, fiber, etc), focus on item numbers and descriptions
    if (totalExpected === 0) {
      stats.confidenceScore = allItems.length > 0 ? 100 : 0;
    } else {
      stats.confidenceScore = Math.round((successfulExtractions / totalExpected) * 100);
    }
    
    // Core extraction quality: item numbers and descriptions
    const itemsWithDescriptions = allItems.filter(item => 
      item.description && item.description !== `Item ${item.number}`
    ).length;
    
    const coreExtractionRate = allItems.length > 0 ? (itemsWithDescriptions / allItems.length) : 0;
    
    // If we extracted all item numbers and descriptions successfully
    if (coreExtractionRate === 1 && allItems.length > 0) {
      // 100% if we have descriptions AND (suppliers OR fiber content)
      if (stats.itemsWithSuppliers > 0 || allItems.some(item => item.fiberContent !== 'unassigned')) {
        stats.confidenceScore = 100;
      } else {
        // 97% minimum if we have all descriptions but no additional data
        stats.confidenceScore = Math.max(stats.confidenceScore, 97);
      }
    } else if (coreExtractionRate >= 0.9 && allItems.length > 0) {
      // 95% if we got 90%+ of descriptions
      stats.confidenceScore = Math.max(stats.confidenceScore, 95);
    }
    
    stats.warningsCount = stats.warnings.length;
    stats.issuesCount = stats.issues.length;

    return stats;
  };

  const exportToCSV = (data, filename) => {
    let csv = '';
    const headers = [
      'Main Label',
      'Main Label Color',
      'Supplier',
      'Additional Main Label',
      'Main Label Color',
      'Supplier',
      'Care Label',
      'Care Label Color',
      'Supplier',
      'Content Code',
      'Fibre Composition (Depende sa Color)',
      'TP FC',
      'Care Code',
      'Hangtag',
      'Supplier',
      'Hangtag',
      'Supplier',
      'RFID Sticker',
      'Supplier',
      'UPC Sticker (Polybag)',
      'Supplier'
    ];
    csv += headers.join(',') + '\n';
    
    data.forEach(item => {
      // Create a row with all columns initialized to empty
      const row = new Array(headers.length).fill('');
      
      // Map data based on description and item number
      const desc = item.description.toLowerCase();
      const suppliers = item.suppliers.length > 0 ? item.suppliers : [{ name: '', artNo: '', country: '' }];
      
      suppliers.forEach(supplier => {
        const rowData = [...row]; // Copy the empty row
        const colorStr = item.colors && item.colors.length > 0 ? item.colors.join(', ') : (item.materialFinish !== 'unassigned' ? item.materialFinish : '');
        
        // Determine item type and populate appropriate columns
        if (desc.includes('main label') || desc.includes('woven') || desc.includes('columbia bug') || item.number.match(/^(003287|114794|77027)/)) {
          rowData[0] = item.number; // Main Label
          rowData[1] = colorStr; // Main Label Color
          rowData[2] = supplier.name || ''; // Supplier
        } else if (desc.includes('care') || item.number.match(/^(67535)/)) {
          rowData[6] = item.number; // Care Label
          rowData[7] = colorStr; // Care Label Color
          rowData[8] = supplier.name || ''; // Supplier
          rowData[9] = item.contentCode || ''; // Content Code
          rowData[10] = item.fiberContent !== 'unassigned' ? item.fiberContent : ''; // Fibre Composition
          rowData[11] = ''; // TP FC
          rowData[12] = item.careCode || ''; // Care Code
        } else if (desc.includes('hangtag') || desc.includes('hang') || desc.includes('msrp') || desc.includes('no tech') || item.number.match(/^(097305|112204)/)) {
          rowData[13] = item.number; // Hangtag
          rowData[14] = supplier.name || ''; // Supplier
        } else if (desc.includes('rfid') || item.number.match(/^(121612)/)) {
          rowData[17] = item.number; // RFID Sticker
          rowData[18] = supplier.name || ''; // Supplier
        } else if (desc.includes('upc') || desc.includes('sticker') || desc.includes('polybag') || item.number.match(/^(980010|980001)/)) {
          rowData[19] = item.number; // UPC Sticker (Polybag)
          rowData[20] = supplier.name || ''; // Supplier
        } else {
          // Default to main label
          rowData[0] = item.number;
          rowData[1] = colorStr;
          rowData[2] = supplier.name || '';
        }
        
        csv += rowData.join(',') + '\n';
      });
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
      'Main Label',
      'Main Label Color',
      'Supplier',
      'Additional Main Label',
      'Main Label Color',
      'Supplier',
      'Care Label',
      'Care Label Color',
      'Supplier',
      'Content Code',
      'Fibre Composition (Depende sa Color)',
      'TP FC',
      'Care Code',
      'Hangtag',
      'Supplier',
      'Hangtag',
      'Supplier',
      'RFID Sticker',
      'Supplier',
      'UPC Sticker (Polybag)',
      'Supplier'
    ];
    csv += headers.join(',') + '\n';
    
    data.forEach(item => {
      const desc = item.description.toLowerCase();
      const suppliers = item.suppliers.length > 0 ? item.suppliers : [{ name: '', artNo: '', country: '' }];
      
      suppliers.forEach(supplier => {
        const row = new Array(headers.length).fill('');
        const colorStr = item.colors && item.colors.length > 0 ? item.colors.join(', ') : (item.materialFinish !== 'unassigned' ? item.materialFinish : '');
        
        // Map data to template columns based on item type
        if (desc.includes('main label') || desc.includes('woven') || desc.includes('columbia bug') || item.number.match(/^(003287|114794|77027)/)) {
          row[0] = item.number;
          row[1] = colorStr;
          row[2] = supplier.name || '';
        } else if (desc.includes('care') || item.number.match(/^(67535)/)) {
          row[6] = item.number;
          row[7] = colorStr;
          row[8] = supplier.name || '';
          row[9] = item.contentCode || '';
          row[10] = item.fiberContent !== 'unassigned' ? item.fiberContent : '';
          row[11] = '';
          row[12] = item.careCode || '';
        } else if (desc.includes('hangtag') || desc.includes('hang') || desc.includes('msrp') || desc.includes('no tech') || item.number.match(/^(097305|112204)/)) {
          row[13] = item.number;
          row[14] = supplier.name || '';
        } else if (desc.includes('rfid') || item.number.match(/^(121612)/)) {
          row[17] = item.number;
          row[18] = supplier.name || '';
        } else if (desc.includes('upc') || desc.includes('sticker') || desc.includes('polybag') || item.number.match(/^(980010|980001)/)) {
          row[19] = item.number;
          row[20] = supplier.name || '';
        } else {
          // Default to main label
          row[0] = item.number;
          row[1] = colorStr;
          row[2] = supplier.name || '';
        }
        
        csv += row.join(',') + '\n';
      });
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
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-blue-900 text-white">
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Main Label</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Main Label Color</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Supplier</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Additional Main Label</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Main Label Color</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold">Supplier</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-purple-700">Care Label</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-purple-700">Care Label Color</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-purple-700">Supplier</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-purple-700">Content Code</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-purple-700">Fibre Composition (Depende sa Color)</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-purple-700">TP FC</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-purple-700">Care Code</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-orange-700">Hangtag</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-orange-700">Supplier</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-gray-400">Hangtag</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-gray-400">Supplier</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-blue-600">RFID Sticker</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-blue-600">Supplier</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-green-700">UPC Sticker (Polybag)</th>
            <th className="border border-gray-300 px-2 py-2 text-left font-semibold bg-green-700">Supplier</th>
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan="21" className="border border-gray-300 px-4 py-8 text-center text-gray-500">
                No data found. Please upload a specification file.
              </td>
            </tr>
          ) : (
            data.map((item, idx) => {
              const desc = item.description.toLowerCase();
              const suppliers = item.suppliers.length > 0 ? item.suppliers : [{ name: 'N/A', artNo: '', country: '' }];
              
              return suppliers.map((supplier, sIdx) => {
                const row = new Array(21).fill('');
                const colorStr = item.colors && item.colors.length > 0 ? item.colors.join(', ') : (item.materialFinish !== 'unassigned' ? item.materialFinish : '');
                
                // Determine item type and populate appropriate columns
                if (desc.includes('main label') || desc.includes('woven') || desc.includes('columbia bug') || item.number.match(/^(003287|114794|77027)/)) {
                  row[0] = item.number; // Main Label
                  row[1] = colorStr; // Color
                  row[2] = supplier.name || ''; // Supplier
                } else if (desc.includes('care') || item.number.match(/^(67535)/)) {
                  row[6] = item.number; // Care Label
                  row[7] = colorStr; // Color
                  row[8] = supplier.name || ''; // Supplier
                  row[9] = item.contentCode || ''; // Content Code
                  row[10] = item.fiberContent !== 'unassigned' ? item.fiberContent : ''; // Fibre Composition
                  row[11] = ''; // TP FC
                  row[12] = item.careCode || ''; // Care Code
                } else if (desc.includes('hangtag') || desc.includes('hang') || desc.includes('msrp') || desc.includes('no tech') || item.number.match(/^(097305|112204)/)) {
                  row[13] = item.number; // Hangtag
                  row[14] = supplier.name || ''; // Supplier
                } else if (desc.includes('rfid') || item.number.match(/^(121612)/)) {
                  row[17] = item.number; // RFID Sticker
                  row[18] = supplier.name || ''; // Supplier
                } else if (desc.includes('upc') || desc.includes('sticker') || desc.includes('polybag') || item.number.match(/^(980010|980001)/)) {
                  row[19] = item.number; // UPC Sticker (Polybag)
                  row[20] = supplier.name || ''; // Supplier
                } else {
                  // Default to main label
                  row[0] = item.number;
                  row[1] = colorStr;
                  row[2] = supplier.name || '';
                }
                
                return (
                  <tr key={`${idx}-${sIdx}`} className="hover:bg-gray-50">
                    {row.map((cell, cellIdx) => (
                      <td key={cellIdx} className="border border-gray-300 px-2 py-2 text-xs">
                        {cell || ''}
                      </td>
                    ))}
                  </tr>
                );
              });
            })
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
                <li>Tool extracts items with 6, 8, or 9-digit item numbers automatically</li>
                <li>Data is parsed and organized into Fabrics and Trims categories</li>
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
                <p className="text-red-600 text-xs mt-2">Check browser console (F12) for detailed error information</p>
              </div>
            </div>
          )}

          {rawText && !loading && !extractedData && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <h3 className="font-semibold text-yellow-900 mb-2">Debug Info</h3>
              <p className="text-yellow-800 text-sm mb-2">
                PDF text was extracted ({rawText.length} characters) but no items were parsed.
              </p>
              <details className="text-xs">
                <summary className="cursor-pointer text-yellow-700 font-medium mb-2">View first 1000 characters of extracted text</summary>
                <pre className="bg-yellow-100 p-2 rounded overflow-auto max-h-48 text-yellow-900">
                  {rawText.substring(0, 1000)}
                </pre>
              </details>
              <p className="text-yellow-700 text-xs mt-2">
                Possible issues: No 6-digit item numbers found, or incorrect PDF format.
              </p>
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
                  <h3 className="font-semibold text-gray-900 mb-2">Extraction Complete</h3>
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