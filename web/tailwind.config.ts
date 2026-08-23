import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-raised': 'rgb(var(--surface-raised) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-soft': 'rgb(var(--ink-soft) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-strong': 'rgb(var(--accent-strong) / <alpha-value>)',
        'accent-soft': 'rgb(var(--accent-soft) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif']
      },
      boxShadow: {
        neu: '6px 6px 16px rgb(var(--shadow-dark) / 0.55), -6px -6px 14px rgb(var(--shadow-light) / 0.9)',
        'neu-sm': '3px 3px 8px rgb(var(--shadow-dark) / 0.45), -3px -3px 8px rgb(var(--shadow-light) / 0.85)',
        'neu-inset': 'inset 4px 4px 8px rgb(var(--shadow-dark) / 0.4), inset -4px -4px 8px rgb(var(--shadow-light) / 0.9)'
      },
      borderRadius: {
        xl: '1rem',
        '2xl': '1.35rem'
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        'fade-up': 'fade-up 0.35s ease-out both'
      }
    }
  },
  plugins: []
};

export default config;
