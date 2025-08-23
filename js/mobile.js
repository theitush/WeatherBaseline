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

    // No longer needed! The original chartRenderer now handles mobile automatically

    // EXPERIMENT 4 & AXIS ALIGNMENT: Debug main chart and shared X-axis
    debugMainChart(chartRenderer) {
        console.log('🧪 EXPERIMENT 4 - Main chart rotation & shared X-axis:');
        const mainSvg = d3.select("#main-svg");
        const mainG = mainSvg.select("g");
        
        // Check rotation is restored
        const mainChartDiv = d3.select('.main-chart');
        const computedStyle = window.getComputedStyle(mainChartDiv.node());
        console.log('📐 CSS transform (should show rotation):', computedStyle.transform);
        
        if (!mainG.empty()) {
            console.log('🎯 SHARED X-AXIS TEST:');
            console.log('📊 Main chart Y scale domain (temp):', chartRenderer.yScale.domain());
            console.log('📊 Main chart Y scale range:', chartRenderer.yScale.range());
            console.log('📊 Histogram X scale domain (temp):', chartRenderer.histXScale.domain());
            console.log('📊 Histogram X scale range:', chartRenderer.histXScale.range());
            
            // Test if domains match (they should for shared axis)
            const mainTempDomain = chartRenderer.yScale.domain();
            const histTempDomain = chartRenderer.histXScale.domain();
            const domainsMatch = mainTempDomain[0] === histTempDomain[0] && mainTempDomain[1] === histTempDomain[1];
            console.log('✅ Shared axis domains match:', domainsMatch);
            
            if (!domainsMatch) {
                console.log('⚠️ DOMAIN MISMATCH - Axes not properly aligned!');
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