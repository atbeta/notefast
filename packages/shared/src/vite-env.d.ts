// CSS / 静态资源模块声明（shared 包自身 + 被宿主包 tsc -b 编译时均需可见）
declare module '*.css' {
  const css: string
  export default css
}
