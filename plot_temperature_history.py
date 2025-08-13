import seaborn as sns
import matplotlib.pyplot as plt

from get_temperature_history import calculate_yearly_aggregates

def plot_temperature_history(data, date, metric='max_temperature', color='grey', window_size=5,
                             title=None, ax_main=None, ax_hist=None):
    """
    Creates a combination plot with temperature distribution over time and histogram.
    
    Parameters:
    -----------
    data : pandas.DataFrame
        Must contain columns: 'date', metric, 'year'
    date : str
        Date to highlight, format 'YYYY-MM-DD'
    metric : str
        Column name for temperature data (default: 'max_temperature')
    color : str
        Color for the plots (default: 'grey')
    title : str, optional
        Plot title. If None, will be generated automatically
    ax_main : matplotlib.axes.Axes, optional
        Axes for main plot. If None, new figure will be created
    ax_hist : matplotlib.axes.Axes, optional
        Axes for histogram. If None, new figure will be created
    
    Returns:
    --------
    fig : matplotlib.figure.Figure
    (ax_main, ax_hist) : tuple of matplotlib.axes.Axes
    """
    
    yearly_aggs = calculate_yearly_aggregates(data, date, metric=metric, window_size=window_size)
    
    # Get current temperature and calculate percentiles
    current_temp = data.loc[data['date'] == date, metric].values[0]
    percent_higher = round((data[metric] > current_temp).mean() * 100, 1)
    
    # Create new figure if axes not provided
    if ax_main is None or ax_hist is None:
        fig = plt.figure(figsize=(12,6))
        gs = fig.add_gridspec(1, 2, width_ratios=[4, 1], wspace=0)
        ax_main = fig.add_subplot(gs[0])
        ax_hist = fig.add_subplot(gs[1], sharey=ax_main)
    
    # Main scatter plot
    sns.scatterplot(data=data, x='date', y=metric, alpha=0.3, color=color, 
                    s=2, edgecolor='k', linewidth=0.5, ax=ax_main)
    ax_main.axhline(current_temp, color=color, linestyle='--', linewidth=1)
    ax_main.scatter(x=data.loc[data['date'] == date, 'date'].values[0],
                    y=current_temp, color=color, alpha=1, label=date)
    
    # Add trend lines and percentile bands
    sns.lineplot(data=yearly_aggs, x='date', y='moving_median', color=color,
                 linestyle='-', label=f'{window_size} Year Median', ax=ax_main, )
    prefix = '' #'moving_'
    ax_main.fill_between(yearly_aggs['date'], yearly_aggs[f'{prefix}25th'],
                         yearly_aggs[f'{prefix}75th'], color=color,
                         alpha=0.2, label='25-75 yearly percentile')
    ax_main.fill_between(yearly_aggs['date'], yearly_aggs[f'{prefix}10th'],
                         yearly_aggs[f'{prefix}90th'], color=color,
                         alpha=0.2, label='10-90 yearly percentile')
    
    # Histogram
    sns.histplot(data=data, y=metric, bins=50, color=color, alpha=0.5, ax=ax_hist)
    ax_hist.axhline(current_temp, color=color, linestyle='--', linewidth=1)
    
    # Style and labels
    ax_main.set_xlabel('Year')
    ax_main.set_ylabel(f'Temperature (°C)')
    ax_hist.set_ylabel('')
    ax_hist.tick_params(axis='y', which='both', left=False, labelleft=False)
    
    # Add brackets and percentages
    ymin, ymax = ax_hist.get_ylim()
    xmin, xmax = ax_hist.get_xlim()
    add_percentage_brackets(ax_hist, current_temp, percent_higher, xmin, xmax, ymin, ymax)
    
    # Title
    if title is None:
        title = f'Temperature Distribution ({data.year.min()}-{data.year.max()})'
    ax_main.set_title(title)
    
    # Legend
    ax_main.legend()
    ax_main.grid(True, alpha=0.5, linestyle='-')
    return ax_main.figure, (ax_main, ax_hist)

def add_percentage_brackets(ax, current_temp, percent_higher, xmin, xmax, ymin, ymax):
    """Helper function to add percentage brackets to the histogram"""
    right_x = xmax + (xmax - xmin) * 0.1
    bracket_depth = (xmax - xmin) * 0.03
    bracket_distance = 0.2
    
    upper_bracket_width = ymax - current_temp - (ymax - ymin) * 0.02
    lower_bracket_width = current_temp - ymin - (ymax - ymin) * 0.02
    
    # Upper bracket
    ax.plot([right_x, right_x], 
            [current_temp + bracket_distance, current_temp + upper_bracket_width], 
            'k-', linewidth=1.5)
    ax.plot([right_x, right_x - bracket_depth], 
            [current_temp + bracket_distance, current_temp + bracket_distance], 
            'k-', linewidth=1.5)
    ax.plot([right_x, right_x - bracket_depth], 
            [current_temp + upper_bracket_width, current_temp + upper_bracket_width], 
            'k-', linewidth=1.5)
    
    # Lower bracket
    ax.plot([right_x, right_x], 
            [current_temp - lower_bracket_width, current_temp - bracket_distance], 
            'k-', linewidth=1.5)
    ax.plot([right_x, right_x - bracket_depth], 
            [current_temp - lower_bracket_width, current_temp - lower_bracket_width], 
            'k-', linewidth=1.5)
    ax.plot([right_x, right_x - bracket_depth], 
            [current_temp - bracket_distance, current_temp - bracket_distance], 
            'k-', linewidth=1.5)
    
    # Add percentage labels
    ax.text(right_x + (xmax - xmin) * 0.02, 
            current_temp + upper_bracket_width/2, 
            f'{percent_higher}%', 
            ha='left', va='center', fontsize=10)
    ax.text(right_x + (xmax - xmin) * 0.02, 
            current_temp - lower_bracket_width/2, 
            f'{round(100-percent_higher,1)}%', 
            ha='left', va='center', fontsize=10)
    
    ax.set_xlim(xmin, right_x + (xmax - xmin) * 0.15)
    ax.spines['right'].set_visible(False)
