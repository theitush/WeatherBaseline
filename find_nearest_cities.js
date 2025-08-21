const fs = require('fs');
const https = require('https');

// Extract coordinates from cache directory
const cacheDir = './cache';
const csvFiles = fs.readdirSync(cacheDir).filter(file => file.endsWith('.csv'));

console.log('Found CSV files:', csvFiles);

const coordinates = csvFiles.map(file => {
    const match = file.match(/weather_hist_(-?\d+\.?\d*)_(-?\d+\.?\d*)\.csv/);
    if (match) {
        return {
            file: file,
            lat: parseFloat(match[1]),
            lon: parseFloat(match[2])
        };
    }
    return null;
}).filter(coord => coord !== null);

console.log('Extracted coordinates:', coordinates);

// Function to get city name from coordinates using OpenStreetMap Nominatim API
async function getCityName(lat, lon) {
    return new Promise((resolve, reject) => {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
        
        const req = https.get(url, {
            headers: {
                'User-Agent': 'CacheToCity/1.0'
            }
        }, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    console.log(`Response for ${lat}, ${lon}:`, data.substring(0, 200));
                    const result = JSON.parse(data);
                    const address = result.address || {};
                    
                    // Try to get city name from various address components
                    const city = address.city || address.town || address.village || 
                                address.municipality || address.county || address.state_district ||
                                address.suburb;
                    const country = address.country;
                    
                    if (city && country) {
                        resolve(`${city}, ${country}`);
                    } else if (result.display_name) {
                        // Fallback to parsing display name
                        const parts = result.display_name.split(',');
                        const cityPart = parts[0].trim();
                        const countryPart = parts[parts.length - 1].trim();
                        resolve(`${cityPart}, ${countryPart}`);
                    } else {
                        resolve(`Unknown Location (${lat}, ${lon})`);
                    }
                } catch (error) {
                    console.error(`JSON parse error for ${lat}, ${lon}:`, error.message);
                    console.error('Raw response:', data);
                    reject(error);
                }
            });
        });
        
        req.on('error', (error) => {
            reject(error);
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

// Process all coordinates
async function processAllCoordinates() {
    const results = {};
    
    for (const coord of coordinates) {
        console.log(`Processing ${coord.file} (${coord.lat}, ${coord.lon})...`);
        
        try {
            // Add delay to be respectful to the API
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const cityName = await getCityName(coord.lat, coord.lon);
            results[coord.file] = cityName;
            console.log(`${coord.file} -> ${cityName}`);
            
        } catch (error) {
            console.error(`Error processing ${coord.file}:`, error.message);
            results[coord.file] = `Error: ${error.message}`;
        }
    }
    
    // Write results to JSON file
    const outputFile = 'cache_cities_mapping.json';
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\nResults written to ${outputFile}`);
    
    return results;
}

// Run the process
processAllCoordinates().catch(console.error);