/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './views/**/*.ejs',
    './public/js/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        // Canna-friend inspired dark theme
        dark: {
          300: 'rgba(255, 255, 255, 0.15)',
          400: 'rgba(255, 255, 255, 0.08)',
          500: '#22292f',
          600: '#1a2027',
          700: '#131920',
          800: '#0f1316',
          900: '#0b0f11',
        },
        // Primary brand colors - Purple theme
        primary: {
          300: '#ddd6fe',
          400: '#c4b5fd',
          500: '#a78bfa',
          600: '#7c3aed',
          700: '#6d28d9',
        },
        // Accent colors
        accent: {
          purple: '#a78bfa',
          'purple-dark': '#7c3aed',
          blue: '#60a5fa',
          'blue-dark': '#3b82f6',
          green: '#34d399',
          'green-dark': '#10b981',
          yellow: '#fbbf24',
          'yellow-dark': '#f59e0b',
          red: '#f87171',
          'red-dark': '#ef4444',
          cyan: '#22d3ee',
          pink: '#f472b6',
          orange: '#fb923c',
        },
        // Status colors
        status: {
          online: '#34d399',
          idle: '#fbbf24',
          dnd: '#f87171',
          offline: 'rgba(255, 255, 255, 0.5)',
          streaming: '#a78bfa',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'glow': '0 0 25px rgba(167, 139, 250, 0.35)',
        'glow-lg': '0 0 40px rgba(167, 139, 250, 0.45)',
        'glow-blue': '0 0 25px rgba(96, 165, 250, 0.35)',
        'card': '0 4px 16px rgba(0, 0, 0, 0.4)',
        'card-hover': '0 8px 32px rgba(0, 0, 0, 0.5)',
        'xl-dark': '0 12px 48px rgba(0, 0, 0, 0.6)',
      },
      backgroundImage: {
        'gradient-primary': 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)',
        'gradient-secondary': 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)',
        'gradient-accent': 'linear-gradient(135deg, #a78bfa 0%, #60a5fa 100%)',
        'gradient-card': 'linear-gradient(135deg, rgba(167, 139, 250, 0.1) 0%, rgba(96, 165, 250, 0.1) 100%)',
        'gradient-success': 'linear-gradient(135deg, #10b981 0%, #34d399 100%)',
        'gradient-danger': 'linear-gradient(135deg, #ef4444 0%, #f87171 100%)',
        'gradient-warning': 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)',
        'gradient-dark': 'linear-gradient(135deg, #0f1316 0%, #0b0f11 100%)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        'spin-slow': 'spin 3s linear infinite',
        'float': 'float 20s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 10px rgba(167, 139, 250, 0.3)' },
          '50%': { boxShadow: '0 0 30px rgba(167, 139, 250, 0.5)' },
        },
        float: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '25%': { transform: 'translate(30px, -30px) scale(1.05)' },
          '50%': { transform: 'translate(-20px, 20px) scale(0.95)' },
          '75%': { transform: 'translate(20px, 30px) scale(1.02)' },
        },
      },
      borderRadius: {
        'xl': '1rem',
        '2xl': '1.5rem',
        '3xl': '2rem',
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
        '128': '32rem',
      },
      transitionDuration: {
        '250': '250ms',
        '350': '350ms',
      },
      backdropBlur: {
        'xs': '2px',
      },
    },
  },
  plugins: [
    // Custom plugin for form styling
    function({ addComponents, theme }) {
      addComponents({
        '.form-input': {
          backgroundColor: 'rgba(0, 0, 0, 0.4)',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          borderWidth: '1px',
          borderRadius: '0.75rem',
          padding: '0.75rem 1rem',
          color: '#ffffff',
          transition: 'all 0.2s ease',
          '&:focus': {
            borderColor: '#a78bfa',
            boxShadow: '0 0 0 3px rgba(167, 139, 250, 0.2)',
            outline: 'none',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
          },
          '&::placeholder': {
            color: 'rgba(255, 255, 255, 0.5)',
          },
        },
        '.btn': {
          padding: '0.625rem 1.25rem',
          borderRadius: '0.625rem',
          fontWeight: '500',
          fontSize: '0.875rem',
          transition: 'all 0.2s ease',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          cursor: 'pointer',
          '&:disabled': {
            opacity: '0.5',
            cursor: 'not-allowed',
          },
        },
        '.btn-primary': {
          background: 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)',
          color: '#ffffff',
          boxShadow: '0 4px 15px rgba(167, 139, 250, 0.35)',
          '&:hover:not(:disabled)': {
            background: 'linear-gradient(135deg, #8b5cf6 0%, #c4b5fd 100%)',
            transform: 'translateY(-2px)',
            boxShadow: '0 6px 20px rgba(167, 139, 250, 0.5)',
          },
        },
        '.btn-secondary': {
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          borderWidth: '1px',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          color: '#ffffff',
          '&:hover:not(:disabled)': {
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
            borderColor: 'rgba(255, 255, 255, 0.15)',
          },
        },
        '.btn-danger': {
          background: 'linear-gradient(135deg, #ef4444 0%, #f87171 100%)',
          color: '#ffffff',
          boxShadow: '0 4px 15px rgba(248, 113, 113, 0.3)',
          '&:hover:not(:disabled)': {
            background: 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)',
            transform: 'translateY(-2px)',
          },
        },
        '.btn-success': {
          background: 'linear-gradient(135deg, #10b981 0%, #34d399 100%)',
          color: '#ffffff',
          boxShadow: '0 4px 15px rgba(52, 211, 153, 0.3)',
          '&:hover:not(:disabled)': {
            background: 'linear-gradient(135deg, #059669 0%, #10b981 100%)',
            transform: 'translateY(-2px)',
          },
        },
        '.card': {
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          borderWidth: '1px',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          borderRadius: '1rem',
          padding: '1.5rem',
          backdropFilter: 'blur(10px)',
          transition: 'all 0.3s ease',
        },
        '.card-hover': {
          '&:hover': {
            borderColor: 'rgba(167, 139, 250, 0.3)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
            transform: 'translateY(-3px)',
          },
        },
        '.glass-card': {
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          borderWidth: '1px',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          borderRadius: '1rem',
          backdropFilter: 'blur(20px)',
        },
      });
    },
  ],
};
