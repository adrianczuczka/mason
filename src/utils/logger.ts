import chalk from "chalk";

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function info(msg: string): void {
  console.log(chalk.blue("ℹ"), msg);
}

export function success(msg: string): void {
  console.log(chalk.green("✔"), msg);
}

export function warn(msg: string): void {
  console.log(chalk.yellow("⚠"), msg);
}

export function error(msg: string): void {
  console.error(chalk.red("✖"), msg);
}

export function debug(msg: string): void {
  if (verbose) {
    console.log(chalk.gray("⋯"), msg);
  }
}
