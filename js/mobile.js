// Mobile controller - Simplified
class MobileController {
    constructor() {
        this.isMobile = window.innerWidth <= 768;
        this.init();
    }

    init() {
        this.checkMobile();
        this.setupEventListeners();
    }

    // Check if mobile
    checkMobile() {
        this.isMobile = window.innerWidth <= 768;
    }

    setupEventListeners() {
        // Add resize event listener
        window.addEventListener('resize', () => {
            const wasMobile = this.isMobile;
            this.checkMobile();
            
            // If switching between mobile and desktop, reload the page
            if (wasMobile !== this.isMobile) {
                location.reload();
            }
        });
    }

    // Show mobile loading
    showMobileLoading() {
        if (!this.isMobile) return;
        
        const loadingSection = document.getElementById('mobile-loading-section');
        if (loadingSection) {
            loadingSection.classList.add('show');
            
            // Auto scroll to loading section
            setTimeout(() => {
                loadingSection.scrollIntoView({ 
                    behavior: 'smooth',
                    block: 'center'
                });
            }, 300);
        }
    }

    // Hide mobile loading and show charts
    showMobileCharts() {
        if (!this.isMobile) return;
        
        const loadingSection = document.getElementById('mobile-loading-section');
        const chartsSection = document.getElementById('mobile-charts-section');
        
        if (loadingSection) {
            loadingSection.classList.remove('show');
        }
        
        if (chartsSection) {
            chartsSection.classList.add('show');
            
            // Auto scroll to charts section
            setTimeout(() => {
                chartsSection.scrollIntoView({ 
                    behavior: 'smooth',
                    block: 'start'
                });
            }, 300);
        }
    }

    // Sync mobile controls with main controls
    syncMobileControls() {
        if (!this.isMobile) return;
        
        const startYearMobile = document.getElementById('start-year-mobile');
        const metricSelectMobile = document.getElementById('metric-select-mobile');
        const startYear = document.getElementById('start-year');
        const metricSelect = document.getElementById('metric-select');
        
        if (!startYearMobile || !metricSelectMobile || !startYear || !metricSelect) return;
        
        // Copy options
        startYearMobile.innerHTML = startYear.innerHTML;
        metricSelectMobile.innerHTML = metricSelect.innerHTML;
        
        // Set values
        startYearMobile.value = startYear.value;
        metricSelectMobile.value = metricSelect.value;
    }

    // Render vertical histogram for mobile (override the desktop version)
    renderMobileHistogram(chartRenderer) {
        if (!this.isMobile) return;
        
        // Clear and rebuild the histogram SVG completely
        const histogramSvg = d3.select("#histogram-svg");
        histogramSvg.selectAll("*").remove();
        
        // Use the exact same data that the main chart uses
        const data = chartRenderer.dataProcessor.filteredData;
        const metric = chartRenderer.dataProcessor.currentMetric;
        
        if (!data || data.length === 0) {
            console.log('No data available for mobile histogram');
            return;
        }
        
        console.log('Mobile histogram data length:', data.length, 'Metric:', metric);
        
        // Mobile histogram dimensions
        const margin = { top: 20, right: 30, bottom: 60, left: 50 };
        const width = 350 - margin.left - margin.right;
        const height = 300 - margin.top - margin.bottom;
        
        const g = histogramSvg.append("g")
            .attr("transform", `translate(${margin.left},${margin.top})`);
        
        // Get temperature values and create bins
        const values = data.map(d => d[metric]);
        const bins = d3.histogram()
            .domain(d3.extent(values))
            .thresholds(15)(values);
        
        // Use the EXACT same temperature domain as the main chart (with padding)
        const xScale = d3.scaleLinear()
            .domain(chartRenderer.yScale.domain())  // Same as main chart!
            .range([0, width]);
            
        const yScale = d3.scaleLinear()
            .domain([0, d3.max(bins, d => d.length)])
            .range([height, 0]);
        
        // Create vertical bars
        g.selectAll(".bar")
            .data(bins)
            .enter().append("rect")
            .attr("class", "bar")
            .attr("x", d => xScale(d.x0))
            .attr("y", d => yScale(d.length))
            .attr("width", d => Math.max(0, xScale(d.x1) - xScale(d.x0) - 1))
            .attr("height", d => height - yScale(d.length))
            .attr("fill", chartRenderer.config.getColorForElement(metric, 'histogramBars'))
            .attr("stroke", "white")
            .attr("stroke-width", 0.5);
        
        // Add X axis (temperature)
        g.append("g")
            .attr("class", "x-axis")
            .attr("transform", `translate(0,${height})`)
            .call(d3.axisBottom(xScale).ticks(6));
        
        // Add Y axis (count)
        g.append("g")
            .attr("class", "y-axis")
            .call(d3.axisLeft(yScale).ticks(6));
        
        // Add axis labels
        g.append("text")
            .attr("transform", "rotate(-90)")
            .attr("y", 0 - margin.left)
            .attr("x", 0 - (height / 2))
            .attr("dy", "1em")
            .style("text-anchor", "middle")
            .style("font-size", "12px")
            .text("Count");
        
        g.append("text")
            .attr("transform", `translate(${width / 2}, ${height + margin.bottom - 10})`)
            .style("text-anchor", "middle")
            .style("font-size", "12px")
            .text("Temperature (°C)");
        
        // Use the SAME logic as desktop charts - don't duplicate!
        const currentDateData = chartRenderer.dataProcessor.getCurrentDateData(chartRenderer.dataProcessor.getFullData());
        
        if (currentDateData.length > 0) {
            const currentTemp = currentDateData[0][metric];
            console.log('Mobile histogram: Using same currentTemp as desktop:', currentTemp);
            
            g.append("line")
                .attr("class", "current-temp-line")
                .attr("x1", xScale(currentTemp))
                .attr("x2", xScale(currentTemp))
                .attr("y1", 0)
                .attr("y2", height)
                .attr("stroke", "#333")
                .attr("stroke-width", 2)
                .attr("stroke-dasharray", "5,5")
                .attr("opacity", 1);
            
            // Store for alignment  
            this.currentTemp = currentTemp;
        }
    }

    // No need for alignment function - both charts now use the same data source!

    // Setup mobile info button
    setupMobileInfoButton() {
        const mobileInfoBtn = document.getElementById('data-info-btn-mobile');
        if (mobileInfoBtn) {
            mobileInfoBtn.addEventListener('click', () => {
                const popup = document.getElementById('data-info-popup');
                if (popup) {
                    popup.classList.add('show');
                }
            });
        }
    }
}

// Export for use in main HTML
window.MobileController = MobileController;