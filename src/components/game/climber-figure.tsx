"use client";

import { motion } from "motion/react";
import { DEFAULT_LOOK, option, type Appearance, type Part } from "@/lib/game/climb";

const col = (look: Appearance, part: Part) => option(part, look[part])?.color ?? option(part, DEFAULT_LOOK[part])!.color!;

/**
 * Original modular character, drawn with its feet at (0,0), about 46 units tall.
 * Layers back to front: backpack, legs, jacket and arms, accessory, head, hair, hat.
 */
export function ClimberFigure({ look, facing = 1, walking = false, duration = 0.8 }: { look: Appearance; facing?: 1 | -1; walking?: boolean; duration?: number }) {
  const skin = col(look, "skin");
  const jacket = col(look, "jacket");
  const pants = col(look, "pants");
  const hair = col(look, "hairColor");
  const bob = walking ? { y: [0, -3, 0, -3, 0, -3, 0] } : { y: 0 };
  const leg = (dir: 1 | -1) => (walking ? { rotate: [0, 22 * dir, -22 * dir, 22 * dir, -22 * dir, 0] } : { rotate: 0 });
  return (
    <motion.g animate={bob} transition={{ duration, ease: "linear" }}>
      <g transform={`scale(${facing},1)`}>
        <ellipse cx={0} cy={1} rx={9} ry={2.5} fill="#000" opacity={0.25} />
        {look.pack === "daypack" && <rect x={-12} y={-25} width={7} height={12} rx={3} fill="#3d5a80" />}
        {look.pack === "ski" && (
          <g>
            <rect x={-13} y={-27} width={8} height={15} rx={2} fill="#c8452c" />
            <rect x={-12} y={-40} width={2} height={28} fill="#d9d9d9" transform="rotate(-8 -11 -26)" />
          </g>
        )}
        {look.pack === "explorer" && (
          <g>
            <rect x={-14} y={-28} width={9} height={17} rx={3} fill="#5b4636" />
            <rect x={-15} y={-14} width={11} height={4} rx={2} fill="#2f8a5f" />
          </g>
        )}
        <motion.rect x={-4} y={-11} width={3.5} height={11} rx={1.5} fill={pants} style={{ originX: "50%", originY: "0%" }} animate={leg(1)} transition={{ duration }} />
        <motion.rect x={0.5} y={-11} width={3.5} height={11} rx={1.5} fill={pants} style={{ originX: "50%", originY: "0%" }} animate={leg(-1)} transition={{ duration }} />
        <rect x={-7} y={-25} width={14} height={16} rx={6} fill={jacket} />
        <rect x={-1} y={-24} width={2} height={13} fill="#000" opacity={0.18} />
        <rect x={-9} y={-23} width={4} height={10} rx={2} fill={jacket} />
        <rect x={6} y={-23} width={4} height={10} rx={2} fill={jacket} transform="rotate(-20 8 -23)" />
        {look.accessory === "scarf" && <rect x={-7} y={-26} width={14} height={4} rx={2} fill="#f2efe6" />}
        {look.accessory === "legend-scarf" && (
          <g>
            <rect x={-7} y={-26} width={14} height={4} rx={2} fill="#ffd166" />
            <rect x={3} y={-24} width={3} height={8} rx={1.5} fill="#ffd166" />
          </g>
        )}
        {look.accessory === "medal" && (
          <g>
            <path d="M-3 -25 L0 -19 L3 -25" fill="none" stroke="#2f6fdc" strokeWidth={1.5} />
            <circle cx={0} cy={-17.5} r={2.4} fill="#ffd166" stroke="#a8743f" strokeWidth={0.6} />
          </g>
        )}
        {look.accessory === "lantern" && (
          <g>
            <rect x={9} y={-14} width={1} height={4} fill="#888" />
            <rect x={7.5} y={-10} width={4} height={5} rx={1} fill="#ffb547" />
          </g>
        )}
        <circle cx={0} cy={-31} r={7} fill={skin} />
        <circle cx={3} cy={-32} r={1} fill="#1b1b1b" />
        {look.accessory === "glasses" && (
          <g fill="none" stroke="#1b1b1b" strokeWidth={0.9}>
            <circle cx={3.2} cy={-32} r={2} />
            <path d="M5.2 -32 H7" />
          </g>
        )}
        {/* hair */}
        {look.hair === "short" && <path d="M-7 -32 Q0 -41 7 -32 Q3 -36 -7 -32Z" fill={hair} />}
        {look.hair === "buzz" && <path d="M-6.8 -32.5 Q0 -39 6.8 -32.5 Q0 -35 -6.8 -32.5Z" fill={hair} opacity={0.85} />}
        {look.hair === "long" && (
          <g fill={hair}>
            <path d="M-7.5 -31 Q0 -42 7.5 -31 Q3 -35 -7.5 -31Z" />
            <rect x={-8} y={-32} width={4} height={12} rx={2} />
          </g>
        )}
        {look.hair === "curly" && (
          <g fill={hair}>
            {[-6, -3, 0, 3, 6].map((x) => <circle key={x} cx={x} cy={-37 + Math.abs(x) * 0.5} r={2.8} />)}
            <circle cx={-7} cy={-32} r={2.4} />
          </g>
        )}
        {look.hair === "bun" && (
          <g fill={hair}>
            <path d="M-7 -32 Q0 -41 7 -32 Q3 -36 -7 -32Z" />
            <circle cx={-5} cy={-39} r={3} />
          </g>
        )}
        {look.accessory === "headphones" && (
          <g>
            <path d="M-7.5 -32 Q0 -44 7.5 -32" fill="none" stroke="#1d2433" strokeWidth={1.6} />
            <rect x={-9.5} y={-34} width={3.5} height={5} rx={1.5} fill="#1d2433" />
          </g>
        )}
        {/* hats */}
        {(look.hat === "tuque" || look.hat === "summit-tuque") && (
          <g>
            <path d="M-7.5 -32 Q0 -45 7.5 -32Z" fill={look.hat === "summit-tuque" ? "#1f8a5b" : jacket} />
            <rect x={-8} y={-33.5} width={16} height={3} rx={1.5} fill={look.hat === "summit-tuque" ? "#ffd166" : "#f2efe6"} />
            <circle cx={0} cy={-41} r={2.4} fill={look.hat === "summit-tuque" ? "#ffd166" : "#f2efe6"} />
            {look.hat === "summit-tuque" && <path d="M-3 -36 L0 -39 L3 -36Z" fill="#f2efe6" />}
          </g>
        )}
        {look.hat === "cap" && (
          <g>
            <path d="M-7 -33 Q0 -42 7 -33Z" fill="#1d2433" />
            <rect x={3} y={-34} width={8} height={2} rx={1} fill="#1d2433" />
          </g>
        )}
        {look.hat === "beret" && <ellipse cx={-1} cy={-37} rx={8} ry={3.2} fill="#7a3b2e" />}
        {look.hat === "helmet" && (
          <g>
            <path d="M-8 -32 Q0 -45 8 -32Z" fill="#2f6fdc" />
            <rect x={-8} y={-33} width={16} height={1.6} fill="#1d2433" />
          </g>
        )}
      </g>
    </motion.g>
  );
}
