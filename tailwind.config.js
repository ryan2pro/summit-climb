/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 《攀峰 SUMMIT》 design tokens (design.md §2.1)
        paper: "#F3EAD8",
        "paper-deep": "#E9DCC0",
        ink: "#2E2418",
        "ink-soft": "#6B5844",
        line: "#D8C7A8",
        terracotta: "#D0713F",
        "terracotta-deep": "#B25A30",
        amber: "#E8A94C",
        sage: "#7FA07A",
        sky: "#8FB9CE",
        danger: "#C84B31",
        snow: "#F6F2E9",
        hud: "rgba(24,17,10,0.55)",
        // shadcn tokens (kept for ui/* components)
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      fontFamily: {
        sans: ['"Noto Sans SC"', 'system-ui', 'sans-serif'],
        display: ['Fredoka', '"ZCOOL KuaiLe"', '"Noto Sans SC"', 'sans-serif'],
        latin: ['Fredoka', '"Noto Sans SC"', 'sans-serif'],
        zh: ['"ZCOOL KuaiLe"', '"Noto Sans SC"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
        btn: ['Fredoka', '"Noto Sans SC"', 'sans-serif'],
      },
      fontSize: {
        "display-xl": "clamp(3rem, 9vw, 7.5rem)",
        "display-lg": "clamp(2.4rem, 6vw, 4.5rem)",
        "display-md": "clamp(1.8rem, 4vw, 3rem)",
      },
      maxWidth: {
        content: "1200px",
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        hard: "0 4px 0 rgba(46,36,24,.9)",
        "hard-sm": "0 3px 0 rgba(46,36,24,.9)",
        "hard-pressed": "0 1px 0 rgba(46,36,24,.9)",
        card: "0 12px 32px rgba(46,36,24,.10)",
        nav: "0 4px 16px rgba(46,36,24,.08)",
        glow: "0 0 32px rgba(232,169,76,.4)",
      },
      transitionTimingFunction: {
        spring: "cubic-bezier(.34,1.56,.64,1)",
        smooth: "cubic-bezier(.22,1,.36,1)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
        marquee: {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-50%)" },
        },
        "scroll-cue": {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(8px)" },
        },
        kenburns: {
          from: { transform: "scale(1)" },
          to: { transform: "scale(1.06)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
        marquee: "marquee 30s linear infinite",
        "scroll-cue": "scroll-cue 1.2s ease-in-out infinite",
        kenburns: "kenburns 20s ease-in-out infinite alternate",
        "fade-in": "fade-in 300ms ease-out both",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
