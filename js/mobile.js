// Mobile interaction logic
class MobileController {
    constructor() {
        this.isMobile = window.innerWidth <= 768;
        this.mobileScrollState = 'controls'; // 'controls', 'loading', 'histogram', 'rotating', 'final'
        this.isDataLoaded = false;
        
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
        
        // Calculate scroll relative to charts section
        const relativeScroll = scrollTop - chartsSectionTop;
        
        if (relativeScroll < 0) {
            // Above charts section
            return;
        } else if (relativeScroll < windowHeight * 0.5) {
            // State 1: Show histogram upright and centered
            this.mobileScrollState = 'histogram';
            if (histogramChart) {
                histogramChart.classList.remove('mobile-rotating', 'mobile-final');
            }
            if (mainChart) {
                mainChart.classList.remove('mobile-visible');
            }
            if (mobileChartControls) {
                mobileChartControls.classList.remove('show');
            }
        } else if (relativeScroll < windowHeight * 1.2) {
            // State 2: Start rotating histogram
            this.mobileScrollState = 'rotating';
            if (histogramChart) {
                histogramChart.classList.add('mobile-rotating');
                histogramChart.classList.remove('mobile-final');
            }
            if (mainChart) {
                mainChart.classList.remove('mobile-visible');
            }
            if (mobileChartControls) {
                mobileChartControls.classList.remove('show');
            }
        } else {
            // State 3: Final position with both charts
            this.mobileScrollState = 'final';
            if (histogramChart) {
                histogramChart.classList.add('mobile-rotating', 'mobile-final');
            }
            if (mainChart) {
                mainChart.classList.add('mobile-visible');
            }
            if (mobileChartControls) {
                mobileChartControls.classList.add('show');
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