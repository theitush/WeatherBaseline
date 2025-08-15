// Chart rendering and visualization module
class ChartRenderer {
    constructor(dataProcessor, config) {
        this.dataProcessor = dataProcessor;
        this.config = config;
        this.previousYearRange = 0;
        
        // Initialize SVG elements and scales
        this.initializeElements();
        this.initializeScales();
    }

    initializeElements() {
        // SVG elements
        this.mainSvg = d3.select("#main-svg");
        this.histSvg = d3.select("#histogram-svg");
        this.tooltip = d3.select("#tooltip");
        
        // Create chart groups
        this.mainG = this.mainSvg.append("g")
            .attr("transform", `translate(${this.config.mainMargin.left},${this.config.mainMargin.top})`);
            
        this.histG = this.histSvg.append("g")
            .attr("transform", `translate(${this.config.histMargin.left},${this.config.histMargin.top})`);
    }

    initializeScales() {
        // Scales
        this.xScale = d3.scaleTime().range([0, this.config.mainWidth]);
        this.yScale = d3.scaleLinear().range([this.config.mainHeight, 0]);
        this.histXScale = d3.scaleLinear().range([0, this.config.histWidth]);
        this.histYScale = d3.scaleLinear().range([this.config.histHeight, 0]);
        this.colorScale = d3.scaleSequential(d3.interpolateViridis);
        
        // Line generator
        this.line = d3.line()
            .x(d => this.xScale(d.date))
            .y(d => this.yScale(d.value))
            .curve(d3.curveMonotoneX);
    }

    // Get y-axis label based on current metric
    getYAxisLabel(metric) {
        const labels = {
            'max_temperature': 'Maximum Apparent Temperature (°C)',
            'min_temperature': 'Minimum Apparent Temperature (°C)',
            'precipitation_sum': 'Precipitation Sum (mm)',
            'wind_speed_10m_max': 'Maximum Wind Speed (km/h)'
        };
        return labels[metric] || 'Value';
    }

    // Format tooltip value based on current metric
    formatTooltipValue(metric, value) {
        const units = {
            'max_temperature': '°C',
            'min_temperature': '°C',
            'precipitation_sum': 'mm',
            'wind_speed_10m_max': 'km/h'
        };
        const labels = {
            'max_temperature': 'Max Apparent Temp',
            'min_temperature': 'Min Apparent Temp',
            'precipitation_sum': 'Precipitation',
            'wind_speed_10m_max': 'Max Wind Speed'
        };
        const unit = units[metric] || '';
        const label = labels[metric] || 'Value';
        return `${label}: ${value.toFixed(1)}${unit}`;
    }

    // Update chart domains
    updateDomains(startYear, endYear) {
        const extents = this.dataProcessor.getDataExtents();
        if (!extents) return;
        
        this.xScale.domain(extents.dateExtent);
        this.yScale.domain([extents.tempExtent[0] - 2, extents.tempExtent[1] + 2]);
        this.histYScale.domain(this.yScale.domain());
        this.colorScale.domain([startYear, endYear]);
        
        // Update histogram x scale
        const bins = d3.histogram()
            .domain(this.yScale.domain())
            .thresholds(30)
            (this.dataProcessor.getFilteredData().map(d => d[this.dataProcessor.currentMetric]));
        
        this.histXScale.domain([0, d3.max(bins, d => d.length)]);
        
        // Track year range change for animation direction
        const currentYearRange = endYear - startYear + 1;
        const isAddingYears = currentYearRange > this.previousYearRange;
        this.previousYearRange = currentYearRange;
        
        // Store animation direction globally
        window.isAddingYears = isAddingYears;
    }

    // Create smooth fade transition
    createFadeTransition(element, newAttributes, colors) {
        element.transition()
            .duration(250)
            .style("opacity", 0)
            .transition()
            .duration(0)
            .call(selection => {
                Object.keys(newAttributes).forEach(attr => {
                    selection.attr(attr, newAttributes[attr]);
                });
                if (colors) {
                    Object.keys(colors).forEach(attr => {
                        selection.attr(attr, colors[attr]);
                    });
                }
            })
            .transition()
            .duration(250)
            .style("opacity", newAttributes.opacity || 1);
    }

    // Draw percentile bands
    drawPercentileBands() {
        const yearlyAggregates = this.dataProcessor.getYearlyAggregates();
        
        if (!yearlyAggregates || yearlyAggregates.length === 0) return;

        console.log('Drawing percentile bands for', yearlyAggregates.length, 'years');
        
        const area90 = d3.area()
            .x(d => this.xScale(d.date))
            .y0(d => this.yScale(d.p10 || d.moving10))
            .y1(d => this.yScale(d.p90 || d.moving90))
            .curve(d3.curveMonotoneX);
        
        const area75 = d3.area()
            .x(d => this.xScale(d.date))
            .y0(d => this.yScale(d.p25 || d.moving25))
            .y1(d => this.yScale(d.p75 || d.moving75))
            .curve(d3.curveMonotoneX);
        
        // Draw 90th percentile band
        let band90 = this.mainG.select(".percentile-band-90");
        if (band90.empty()) {
            band90 = this.mainG.append("path")
                .attr("class", "percentile-band percentile-band-90")
                .attr("fill", this.config.getColorForElement(this.dataProcessor.currentMetric, 'percentileBand90'))
                .style("opacity", 1);
        }
        
        try {
            this.createFadeTransition(
                band90.datum(yearlyAggregates),
                { d: area90, opacity: 1 },
                { fill: this.config.getColorForElement(this.dataProcessor.currentMetric, 'percentileBand90') }
            );
        } catch (e) {
            console.error('Error drawing 90th percentile band:', e);
        }
        
        // Draw 75th percentile band  
        let band75 = this.mainG.select(".percentile-band-75");
        if (band75.empty()) {
            band75 = this.mainG.append("path")
                .attr("class", "percentile-band percentile-band-75")
                .attr("fill", this.config.getColorForElement(this.dataProcessor.currentMetric, 'percentileBand75'))
                .style("opacity", 1);
        }
        
        try {
            this.createFadeTransition(
                band75.datum(yearlyAggregates),
                { d: area75, opacity: 1 },
                { fill: this.config.getColorForElement(this.dataProcessor.currentMetric, 'percentileBand75') }
            );
        } catch (e) {
            console.error('Error drawing 75th percentile band:', e);
        }
    }

    // Draw trend line
    drawTrendLine() {
        const yearlyAggregates = this.dataProcessor.getYearlyAggregates();
        
        if (!yearlyAggregates || yearlyAggregates.length === 0) return;

        // Filter to only include years with valid moving medians
        const validMovingMedianData = yearlyAggregates.filter(d => d.movingMedian !== null);

        let trendLine = this.mainG.select(".trend-line");
        if (trendLine.empty()) {
            trendLine = this.mainG.append("path")
                .attr("class", "trend-line")
                .attr("stroke", this.config.getColorForElement(this.dataProcessor.currentMetric, 'trendLine'))
                .attr("stroke-width", 3)
                .attr("fill", "none");
        }
        
        try {
            if (validMovingMedianData.length > 0) {
                this.createFadeTransition(
                    trendLine.datum(validMovingMedianData),
                    { d: this.line.y(d => this.yScale(d.movingMedian)) },
                    { stroke: this.config.getColorForElement(this.dataProcessor.currentMetric, 'trendLine') }
                );
            } else {
                // Hide trend line if no valid data
                trendLine.style("opacity", 0);
            }
        } catch (e) {
            console.error('Error drawing trend line:', e);
        }
    }

    // Draw scatter points
    drawScatterPoints() {
        const filteredData = this.dataProcessor.getFilteredData();
        
        const circles = this.mainG.selectAll(".data-point")
            .data(filteredData, d => `${d.date.getTime()}_${d.year}`);
            
        // Remove points that are no longer in range
        circles.exit()
            .transition()
            .duration(500)
            .attr("opacity", 0)
            .remove();
        
        // Update existing points
        circles.transition()
            .duration(500)
            .attr("cx", d => this.xScale(d.date))
            .attr("cy", d => this.yScale(d[this.dataProcessor.currentMetric]))
            .attr("fill", this.config.getColorForElement(this.dataProcessor.currentMetric, 'dataPoints'));
            
        // Add new points
        circles.enter()
            .append("circle")
            .attr("class", "data-point")
            .attr("cx", d => this.xScale(d.date))
            .attr("cy", d => this.yScale(d[this.dataProcessor.currentMetric]))
            .attr("r", 2)
            .attr("fill", this.config.getColorForElement(this.dataProcessor.currentMetric, 'dataPoints'))
            .attr("opacity", 0)
            .transition()
            .duration(500)
            .attr("opacity", 1);
        
        // Add tooltips to all points
        this.mainG.selectAll(".data-point")
            .on("mouseover", (event, d) => {
                this.tooltip.style("opacity", 1)
                    .html(`Date: ${d.date.toDateString()}<br/>
                           ${this.formatTooltipValue(this.dataProcessor.currentMetric, d[this.dataProcessor.currentMetric])}`)
                    .style("left", (event.pageX + 10) + "px")
                    .style("top", (event.pageY - 10) + "px");
            })
            .on("mouseout", () => {
                this.tooltip.style("opacity", 0);
            });
    }

    // Draw current temperature indicators
    drawCurrentTemperatureIndicators() {
        const currentDateData = this.dataProcessor.getCurrentDateData();
        
        if (currentDateData.length > 0) {
            const currentTemp = currentDateData[0][this.dataProcessor.currentMetric];
            
            // Current temperature line
            this.mainG.append("line")
                .attr("class", "current-temp-line")
                .attr("x1", 0)
                .attr("x2", this.config.mainWidth)
                .attr("y1", this.yScale(currentTemp))
                .attr("y2", this.yScale(currentTemp));
            
            // Current temperature point
            this.mainG.selectAll(".current-temp-point")
                .data(currentDateData)
                .enter()
                .append("circle")
                .attr("class", "current-temp-point")
                .attr("cx", d => this.xScale(d.date))
                .attr("cy", d => this.yScale(d[this.dataProcessor.currentMetric]))
                .attr("r", 4);
        }
    }

    // Draw main chart axes and grid
    drawAxesAndGrid() {
        // Add grid
        const xAxis = d3.axisBottom(this.xScale).tickFormat(d3.timeFormat("%Y"));
        const yAxis = d3.axisLeft(this.yScale);
        
        this.mainG.append("g")
            .attr("class", "grid")
            .attr("transform", `translate(0,${this.config.mainHeight})`)
            .call(d3.axisBottom(this.xScale)
                .tickSize(-this.config.mainHeight)
                .tickFormat("")
            );
        
        this.mainG.append("g")
            .attr("class", "grid")
            .call(d3.axisLeft(this.yScale)
                .tickSize(-this.config.mainWidth)
                .tickFormat("")
            );
        
        // Add axes
        this.mainG.append("g")
            .attr("class", "axis")
            .attr("transform", `translate(0,${this.config.mainHeight})`)
            .call(xAxis);
        
        this.mainG.append("g")
            .attr("class", "axis")
            .call(yAxis);
        
        // Add axis labels
        this.mainG.append("text")
            .attr("transform", "rotate(-90)")
            .attr("y", 0 - this.config.mainMargin.left)
            .attr("x", 0 - (this.config.mainHeight / 2))
            .attr("dy", "1em")
            .style("text-anchor", "middle")
            .style("font-size", "12px")
            .text(this.getYAxisLabel(this.dataProcessor.currentMetric));
        
        this.mainG.append("text")
            .attr("transform", `translate(${this.config.mainWidth / 2}, ${this.config.mainHeight + this.config.mainMargin.bottom - 5})`)
            .style("text-anchor", "middle")
            .style("font-size", "12px")
            .text("Year");
    }

    // Draw main chart
    drawMainChart() {
        const filteredData = this.dataProcessor.getFilteredData();
        if (filteredData.length === 0) {
            this.mainG.selectAll("*").remove();
            return;
        }
        
        // Clear non-data elements first
        this.mainG.selectAll(".grid").remove();
        this.mainG.selectAll(".axis").remove();
        this.mainG.selectAll(".current-temp-line").remove();
        this.mainG.selectAll(".current-temp-point").remove();
        this.mainG.selectAll("text").remove();
        
        // Draw chart elements
        this.drawAxesAndGrid();
        this.drawPercentileBands();
        this.drawTrendLine();
        this.drawScatterPoints();
        this.drawCurrentTemperatureIndicators();
    }

    // Draw histogram bars
    drawHistogramBars(bins) {
        
        const bars = this.histG.selectAll(".bar")
            .data(bins, (d, i) => `bin_${i}`);
            
        // Remove bars that are no longer needed
        bars.exit()
            .transition()
            .duration(500)
            .attr("width", 0)
            .attr("opacity", 0)
            .remove();
        
        // Update existing bars
        bars.transition()
            .duration(500)
            .attr("y", d => this.histYScale(d.x1))
            .attr("width", d => this.histXScale(d.length))
            .attr("height", d => this.histYScale(d.x0) - this.histYScale(d.x1))
            .attr("fill", this.config.getColorForElement(this.dataProcessor.currentMetric, 'histogramBars'));
        
        // Add new bars
        bars.enter()
            .append("rect")
            .attr("class", "bar")
            .attr("x", 0)
            .attr("y", d => this.histYScale(d.x1))
            .attr("width", 0)
            .attr("height", d => this.histYScale(d.x0) - this.histYScale(d.x1))
            .attr("fill", this.config.getColorForElement(this.dataProcessor.currentMetric, 'histogramBars'))
            .attr("opacity", 1)
            .transition()
            .duration(500)
            .attr("width", d => this.histXScale(d.length));
    }

    // Draw histogram percentile brackets
    drawHistogramBrackets(currentTemp) {
        const filteredData = this.dataProcessor.getFilteredData();
        
        // Calculate percentiles
        const higherCount = filteredData.filter(d => d[this.dataProcessor.currentMetric] > currentTemp).length;
        const totalCount = filteredData.length;
        const percentHigher = (higherCount / totalCount * 100).toFixed(1);
        const percentLower = (100 - parseFloat(percentHigher)).toFixed(1);
        
        // Bracket dimensions
        const rightX = this.config.histWidth + 15;
        const bracketWidth = 18;
        const yMid = this.histYScale(currentTemp);
        const yTop = 15;
        const yBottom = this.config.histHeight - 15;
        
        // Upper bracket
        const upperBracketGroup = this.histG.append("g").attr("class", "upper-bracket");
        
        upperBracketGroup.append("path")
            .attr("d", `M ${rightX} ${yTop} 
                       L ${rightX + bracketWidth * 0.5} ${yTop}
                       Q ${rightX + bracketWidth * 0.8} ${yTop + 10} ${rightX + bracketWidth * 0.5} ${yTop + 20}
                       L ${rightX + bracketWidth * 0.5} ${yMid - 25}
                       Q ${rightX + bracketWidth * 0.8} ${yMid - 15} ${rightX + bracketWidth * 0.5} ${yMid - 5}`)
            .attr("stroke", "#666")
            .attr("stroke-width", 1.5)
            .attr("fill", "none");
        
        upperBracketGroup.append("text")
            .attr("x", rightX + bracketWidth + 8)
            .attr("y", (yTop + yMid - 10) / 2)
            .attr("dy", "0.35em")
            .attr("text-anchor", "start")
            .style("font-size", "13px")
            .style("font-weight", "normal")
            .style("fill", "#555")
            .text(percentHigher + '%');
        
        // Lower bracket
        const lowerBracketGroup = this.histG.append("g").attr("class", "lower-bracket");
        
        lowerBracketGroup.append("path")
            .attr("d", `M ${rightX + bracketWidth * 0.5} ${yMid + 5}
                       Q ${rightX + bracketWidth * 0.8} ${yMid + 15} ${rightX + bracketWidth * 0.5} ${yMid + 25}
                       L ${rightX + bracketWidth * 0.5} ${yBottom - 20}
                       Q ${rightX + bracketWidth * 0.8} ${yBottom - 10} ${rightX + bracketWidth * 0.5} ${yBottom}
                       L ${rightX} ${yBottom}`)
            .attr("stroke", "#666")
            .attr("stroke-width", 1.5)
            .attr("fill", "none");
        
        lowerBracketGroup.append("text")
            .attr("x", rightX + bracketWidth + 8)
            .attr("y", (yMid + 10 + yBottom) / 2)
            .attr("dy", "0.35em")
            .attr("text-anchor", "start")
            .style("font-size", "13px")
            .style("font-weight", "normal")
            .style("fill", "#555")
            .text(percentLower + '%');
    }

    // Draw histogram
    drawHistogram() {
        const filteredData = this.dataProcessor.getFilteredData();
        if (filteredData.length === 0) {
            this.histG.selectAll("*").remove();
            return;
        }
        
        // Clear non-data elements thoroughly
        this.histG.selectAll(".axis").remove();
        this.histG.selectAll(".current-temp-line").remove();
        this.histG.selectAll(".upper-bracket").remove();
        this.histG.selectAll(".lower-bracket").remove();
        this.histG.selectAll("text").remove();
        this.histG.selectAll("g.upper-bracket").remove();
        this.histG.selectAll("g.lower-bracket").remove();
        this.histG.selectAll("g").selectAll("text").remove();
        this.histG.selectAll("*:not(.bar)").remove();
        
        // Create histogram data
        const bins = d3.histogram()
            .domain(this.yScale.domain())
            .thresholds(30)
            (filteredData.map(d => d[this.dataProcessor.currentMetric]));
        
        // Draw bars
        this.drawHistogramBars(bins);
        
        // Current temperature line and brackets
        const currentDateData = this.dataProcessor.getCurrentDateData(this.dataProcessor.getFullData());
        
        if (currentDateData.length > 0 && filteredData.length > 0) {
            const currentTemp = currentDateData[0][this.dataProcessor.currentMetric];
            
            this.histG.append("line")
                .attr("class", "current-temp-line")
                .attr("x1", 0)
                .attr("x2", this.config.histWidth)
                .attr("y1", this.histYScale(currentTemp))
                .attr("y2", this.histYScale(currentTemp));
            
            this.drawHistogramBrackets(currentTemp);
        }
        
        // Add x-axis label
        this.histG.append("text")
            .attr("transform", `translate(${this.config.histWidth / 2}, ${this.config.histHeight + 30})`)
            .style("text-anchor", "middle")
            .style("font-size", "12px")
            .text("Count");
    }

    // Update both charts
    updateCharts() {
        this.drawMainChart();
        this.drawHistogram();
    }
}