// Mobile interaction logic
class MobileController {
    constructor() {
        this.isMobile = window.innerWidth <= 768;
        this.mobileScrollState = 'controls'; // 'controls', 'loading', 'histogram', 'rotating', 'final'
        this.previousScrollState = 'controls'; // Track previous state to avoid re-rendering
        this.isDataLoaded = false;
        this.chartRenderer = null; // Store chart renderer locally
        
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
            
            // If switching between mobile and desktop, reload the page for now
            if (wasMobile !== this.isMobile) {
                location.reload();
            }
        });
    }

    // Mobile scroll handler
    handleMobileScroll() {
        if (!this.isMobile || !this.isDataLoaded) return;
        
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const windowHeight = window.innerHeight;
        const chartsSection = document.getElementById('mobile-charts-section');
        
        if (!chartsSection) return;
        
        const chartsSectionTop = chartsSection.offsetTop;
        const histogramChart = chartsSection.querySelector('.histogram-chart');
        const mainChart = chartsSection.querySelector('.main-chart');
        const mobileChartControls = document.getElementById('mobile-chart-controls');
        
        console.log('Elements found - histogramChart:', !!histogramChart, 'mainChart:', !!mainChart);
        
        // Calculate scroll relative to charts section
        const relativeScroll = scrollTop - chartsSectionTop;
        
        // Debug logging  
        console.log('Scroll:', scrollTop, 'ChartsTop:', chartsSectionTop, 'Relative:', relativeScroll, 'WindowHeight:', windowHeight);
        
        let newState;
        if (relativeScroll < 150) {
            newState = 'histogram';
        } else if (relativeScroll < 500) {
            newState = 'rotating';
        } else {
            newState = 'final';
        }
        
        // Only render histogram when state actually changes, not on every scroll
        
        // Only update if state has changed
        if (newState !== this.previousScrollState) {
            console.log('STATE CHANGE:', this.previousScrollState, '->', newState);
            this.previousScrollState = newState;
            this.mobileScrollState = newState;
            
            if (newState === 'histogram') {
                // State 1: Show histogram upright and centered
                if (histogramChart) {
                    histogramChart.classList.remove('mobile-rotating', 'mobile-final');
                    console.log('State: histogram upright');
                }
                if (mainChart) {
                    mainChart.classList.remove('mobile-visible');
                }
                if (mobileChartControls) {
                    mobileChartControls.classList.remove('show');
                }
            } else if (newState === 'rotating') {
                // State 2: Start rotating histogram
                if (histogramChart) {
                    histogramChart.classList.add('mobile-rotating');
                    histogramChart.classList.remove('mobile-final');
                    console.log('State: rotating');
                }
                if (mainChart) {
                    mainChart.classList.remove('mobile-visible');
                }
                if (mobileChartControls) {
                    mobileChartControls.classList.remove('show');
                }
            } else {
                // State 3: Final position with both charts
                if (histogramChart) {
                    histogramChart.classList.add('mobile-rotating', 'mobile-final');
                    console.log('State: final with both charts');
                }
                if (mainChart) {
                    mainChart.classList.add('mobile-visible');
                }
                if (mobileChartControls) {
                    mobileChartControls.classList.add('show');
                }
            }
        }
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
            this.isDataLoaded = true;
            
            const histogramChart = chartsSection.querySelector('.histogram-chart');
            const mainChart = chartsSection.querySelector('.main-chart');
            
            // Ensure histogram starts upright and main chart is hidden
            if (histogramChart) {
                histogramChart.classList.remove('mobile-rotating', 'mobile-final');
            }
            if (mainChart) {
                mainChart.classList.remove('mobile-visible');
            }
            
            // Auto scroll to charts section
            setTimeout(() => {
                chartsSection.scrollIntoView({ 
                    behavior: 'smooth',
                    block: 'start'
                });
                
                // Setup scroll listener after charts are shown
                setTimeout(() => {
                    window.addEventListener('scroll', () => this.handleMobileScroll(), { passive: true });
                    // Trigger initial scroll check
                    this.handleMobileScroll();
                }, 500);
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
        
        // Add event listeners for mobile controls
        startYearMobile.addEventListener('change', (e) => {
            startYear.value = e.target.value;
            startYear.dispatchEvent(new Event('change'));
        });
        
        metricSelectMobile.addEventListener('change', (e) => {
            metricSelect.value = e.target.value;
            metricSelect.dispatchEvent(new Event('change'));
        });
    }

    // Override histogram rendering for mobile (vertical bars)
    renderMobileHistogram(chartRenderer, isFlipped = false) {
        if (!this.isMobile) return;
        
        // Get the histogram SVG
        const histogramSvg = d3.select("#histogram-svg");
        
        // Clear existing content
        histogramSvg.selectAll("*").remove();
        
        // Get data from chart renderer
        const data = chartRenderer.dataProcessor.filteredData;
        const metric = chartRenderer.dataProcessor.currentMetric;
        
        if (!data || data.length === 0) return;
        
        // Set up dimensions for vertical bars - more room at top
        const margin = { top: 40, right: 30, bottom: 80, left: 60 };
        const width = 350 - margin.left - margin.right;
        const height = 400 - margin.top - margin.bottom;
        
        // Create main group
        const g = histogramSvg.append("g")
            .attr("transform", `translate(${margin.left},${margin.top})`);
        
        // Get temperature values
        const values = data.map(d => d[metric]);
        
        // Create bins for histogram
        const bins = d3.histogram()
            .domain(d3.extent(values))
            .thresholds(15)(values);
        
        // Set up scales - X is temperature, Y is count
        const tempExtent = d3.extent(values);
        const xScale = d3.scaleLinear()
            .domain(isFlipped ? [tempExtent[1], tempExtent[0]] : tempExtent)
            .range([0, width]);
            
        console.log('Histogram rendering - isFlipped:', isFlipped, 'domain:', xScale.domain());
            
        const yScale = d3.scaleLinear()
            .domain([0, d3.max(bins, d => d.length)])
            .range([height, 0]);
        
        // Create vertical bars with proper colors
        g.selectAll(".bar")
            .data(bins)
            .enter().append("rect")
            .attr("class", "bar")
            .attr("x", d => xScale(d.x0)) // Normal positioning
            .attr("y", d => yScale(d.length))
            .attr("width", d => Math.max(0, xScale(d.x1) - xScale(d.x0) - 1))
            .attr("height", d => height - yScale(d.length))
            .attr("fill", chartRenderer.config.getColorForElement(metric, 'histogramBars'))
            .attr("stroke", "white")
            .attr("stroke-width", 0.5);
        
        // Add X axis (temperature) - normal left-to-right orientation initially
        // Low temps on left, high temps on right (normal axis)
        g.append("g")
            .attr("class", "x-axis")
            .attr("transform", `translate(0,${height})`)
            .call(d3.axisBottom(xScale).ticks(6));
        
        // Add Y axis (count) on RIGHT side (will be bottom after rotation)
        const yAxis = g.append("g")
            .attr("class", "y-axis-right")
            .attr("transform", `translate(${width},0)`)
            .call(d3.axisRight(yScale).ticks(6));
            
        // Style the text elements
        yAxis.selectAll("text")
            .style("font-size", "12px")
            .style("fill", "#333")
            .style("opacity", "1")
            .attr("class", "y-axis-text");
        
        // Add current temperature line - get from target date data
        const targetDate = document.getElementById('target-date').value;
        console.log('Target date:', targetDate, 'Data length:', data.length);
        
        if (targetDate && data.length > 0) {
            // Find the current day's average temperature
            const targetData = data.find(d => d.date.toISOString().split('T')[0] === targetDate);
            console.log('Target data found:', !!targetData);
            
            if (targetData) {
                const currentTemp = targetData[metric];
                console.log('Adding current temp line at:', currentTemp, 'X position:', xScale(currentTemp));
                
                g.append("line")
                    .attr("class", "current-temp-line")
                    .attr("x1", xScale(currentTemp))
                    .attr("x2", xScale(currentTemp))
                    .attr("y1", 0)
                    .attr("y2", height)
                    .attr("stroke", "#333")
                    .attr("stroke-width", 3)
                    .attr("stroke-dasharray", "5,5")
                    .attr("opacity", 1);
            } else {
                console.log('No target data found. Available dates:', data.slice(0,3).map(d => d.date.toISOString().split('T')[0]));
            }
        }
    }

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