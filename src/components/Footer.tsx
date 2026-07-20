import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { scrollToSection } from '@/lib/scroll';

/**
 * Landing footer (home.md §9): ink bg, snow text; brand / 导航 / 技术 columns;
 * bottom attribution row with dashed top border.
 */

const TECH = ['Three.js', 'WebRTC', 'IndexedDB', 'React'];

const fade = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-10% 0px' },
};

export default function Footer() {
  return (
    <footer className="bg-ink text-snow">
      <div className="mx-auto max-w-content px-6 py-16">
        <div className="grid gap-10 md:grid-cols-3">
          {/* brand */}
          <motion.div {...fade} transition={{ duration: 0.5 }}>
            <div className="flex items-center gap-3">
              <img src="/logo.svg" alt="攀峰 logo" className="h-10 w-10" />
              <div>
                <div className="font-zh text-2xl leading-tight">攀峰 · SUMMIT</div>
              </div>
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-snow/70">
              和朋友一起，登上随机生成的山顶。
            </p>
          </motion.div>

          {/* nav */}
          <motion.nav {...fade} transition={{ duration: 0.5, delay: 0.1 }} aria-label="页脚导航">
            <h3 className="font-latin text-xs font-semibold uppercase tracking-[0.2em] text-amber">导航</h3>
            <ul className="mt-4 space-y-2.5 text-sm">
              <li>
                <button type="button" onClick={() => scrollToSection('howto')} className="text-snow/80 transition-colors hover:text-terracotta">
                  玩法
                </button>
              </li>
              <li>
                <button type="button" onClick={() => scrollToSection('features')} className="text-snow/80 transition-colors hover:text-terracotta">
                  特色
                </button>
              </li>
              <li>
                <button type="button" onClick={() => scrollToSection('controls')} className="text-snow/80 transition-colors hover:text-terracotta">
                  操作
                </button>
              </li>
              <li>
                <Link to="/lobby" className="font-bold text-snow transition-colors hover:text-terracotta">
                  开始游戏 →
                </Link>
              </li>
            </ul>
          </motion.nav>

          {/* tech */}
          <motion.div {...fade} transition={{ duration: 0.5, delay: 0.2 }}>
            <h3 className="font-latin text-xs font-semibold uppercase tracking-[0.2em] text-amber">技术</h3>
            <div className="mt-4 flex flex-wrap gap-2">
              {TECH.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-snow/25 px-3 py-1 font-mono text-xs text-snow/80 transition-transform duration-200 ease-spring hover:-translate-y-0.5 hover:border-amber hover:text-amber"
                >
                  {t}
                </span>
              ))}
            </div>
          </motion.div>
        </div>

        <motion.div
          {...fade}
          transition={{ duration: 0.5, delay: 0.25 }}
          className="mt-12 border-t-2 border-dashed border-snow/20 pt-6 text-center text-xs text-snow/50"
        >
          灵感来自 Steam 游戏《PEAK》 · 本项目为粉丝致敬作品 · 数据只保存在你的浏览器里
        </motion.div>
      </div>
    </footer>
  );
}
