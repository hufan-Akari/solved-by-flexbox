const connect = require('connect');
const del = require('del');
const frontMatter = require('front-matter');
const gulp = require('gulp');
const cssnext = require('gulp-cssnext');
const eslint = require('gulp-eslint');
const htmlmin = require('gulp-htmlmin');
const gulpIf = require('gulp-if');
const plumber = require('gulp-plumber');
const rename = require('gulp-rename');
const gutil = require('gulp-util');
const he = require('he');
const hljs = require('highlight.js');
const nunjucks = require('nunjucks');
const assign = require('object-assign');
const path = require('path');
const Remarkable = require('remarkable');
const serveStatic = require('serve-static');
const through = require('through2');
const webpack = require('webpack');
const {argv} = require('yargs');

/**
 * The output directory for all the built files.
 */
const DEST = path.resolve('./build');

/**
 * The name of the Github repo.
 */
const REPO = 'solved-by-flexbox';

/**
 * The base public path of the site.
 */
const PUBLIC_PATH = path.join('/', (isProd() ? REPO : '.'), '/');


function isProd() {
  return process.env.NODE_ENV == 'production';
}


nunjucks.configure('templates', {autoescape: false});


function streamError(err) {
  gutil.beep();
  gutil.log(err instanceof gutil.PluginError ? err.toString() : err.stack);
}


function extractFrontMatter(options) {
  let files = [];
  let site = assign({demos: []}, options);
  return through.obj(
    function transform(file, enc, done) {
      let contents = file.contents.toString();
      let yaml = frontMatter(contents);

      if (yaml.attributes) {
        let slug = path.basename(file.path, path.extname(file.path));
        let permalink = site.baseUrl +
            (slug == 'index' ? '' : 'demos/' + slug + '/');

        file.contents = new Buffer(yaml.body);
        file.data = {
          site: site,
          page: assign({
            slug: slug,
            permalink: permalink
          }, yaml.attributes)
        };

        if (file.path.indexOf('demos') > -1) {
          site.demos.push(file.data.page);
        }
      }

      files.push(file);
      done();
    },
    function flush(done) {
      files.forEach(function(file) { this.push(file); }.bind(this));
      done();
    }
  );
}


function renderMarkdown() {
  let markdown = new Remarkable({
    html: true,
    typographer: true,
    highlight: function (code, lang) {
      // Unescape to avoid double escaping.
      code = he.unescape(code);
      return lang ? hljs.highlight(lang, code).value : he.escape(code);
    }
  });
  return through.obj(function (file, enc, cb) {
    try {
      if (path.extname(file.path) == '.md') {
        file.contents = new Buffer(markdown.render(file.contents.toString()));
      }
      this.push(file);
    }
    catch (err) {
      this.emit('error', new gutil.PluginError('renderMarkdown', err, {
        fileName: file.path
      }));
    }
    cb();
  });
}


function renderTemplate() {
  return through.obj(function (file, enc, cb) {
    try {
      // Render the file's content to the page.content template property.
      let content = file.contents.toString();
      file.data.page.content = nunjucks.renderString(content, file.data);

      // Then render the page in its template.
      let template = file.data.page.template;
      file.contents = new Buffer(nunjucks.render(template, file.data));

      this.push(file);
    }
    catch (err) {
      this.emit('error', new gutil.PluginError('renderTemplate', err, {
        fileName: file.path
      }));
    }
    cb();
  });
}


gulp.task('pages', function() {
  let baseData = require('./config.json');
  let overrides = {
    baseUrl: PUBLIC_PATH,
    env: process.env.NODE_ENV || 'development'
  };
  let siteData = assign(baseData, overrides);

  return gulp.src(['*.html', './demos/**/*'], {base: process.cwd()})
      .pipe(plumber({errorHandler: streamError}))
      .pipe(extractFrontMatter(siteData))
      .pipe(renderMarkdown())
      .pipe(renderTemplate())
      .pipe(rename(function(path) {
        if (path.basename != 'index' && path.basename != '404') {
          path.dirname += '/' + path.basename;
          path.basename = 'index';
          path.extname = '.html';
        }
      }))
      .pipe(gulpIf(isProd(), htmlmin({
        removeComments: true,
        collapseWhitespace: true,
        collapseBooleanAttributes: true,
        removeAttributeQuotes: true,
        removeRedundantAttributes: true,
        useShortDoctype: true,
        removeEmptyAttributes: true,
        minifyJS: true,
        minifyCSS: true
      })))
      .pipe(gulp.dest(DEST));
});


gulp.task('images', function() {
  return gulp.src('./assets/images/**/*')
      .pipe(gulp.dest(path.join(DEST, 'images')));
});


gulp.task('css', function() {
  return gulp.src('./assets/css/main.css')
      .pipe(plumber({errorHandler: streamError}))
      .pipe(cssnext({
        browsers: '> 1%, last 2 versions, Safari > 5, ie > 9, Firefox ESR',
        compress: true,
        url: false
      }))
      .pipe(gulp.dest(DEST));
});


gulp.task('lint', function() {
  return gulp.src([
    'gulpfile.js',
    'assets/javascript/**/*.js'
  ])
  .pipe(eslint())
  .pipe(eslint.format())
  .pipe(eslint.failAfterError());
});


gulp.task('javascript:main', ((compiler) => {
  const createCompiler = () => {
    const entry = './assets/javascript/main.js';
    const plugins = [
      new webpack.DefinePlugin({
        'process.env.NODE_ENV':
            JSON.stringify(process.env.NODE_ENV || 'development'),
        'process.env.SBF_PUBLIC_PATH': JSON.stringify(PUBLIC_PATH),
      })
    ];
    return webpack({
      mode: isProd() ? 'production' : 'development',
      entry: entry,
      output: {
        path: path.resolve(__dirname, DEST),
        publicPath: PUBLIC_PATH,
        filename: path.basename(entry),
      },
      devtool: '#source-map',
      plugins,
      module: {
        rules: [{
          test: /\.js$/,
          use: {
            loader: 'babel-loader',
            options: {
              babelrc: false,
              cacheDirectory: false,
              presets: [
                ['@babel/preset-env', {'modules': false}],
              ],
            },
          }
        }],
      },
      performance: {hints: false},
      cache: {},
    });
  };
  return (done) => {
    (compiler || (compiler = createCompiler())).run(function(err, stats) {
      if (err) return done(err);
      gutil.log('[webpack]', stats.toString('minimal'));
      done();
    });
  };
})());


gulp.task('javascript:polyfills', ((compiler) => {
  const createCompiler = () => {
    const entry = './assets/javascript/polyfills.js';
    return webpack({
      mode: 'production',
      entry: entry,
      output: {
        path: path.resolve(__dirname, DEST),
        publicPath: PUBLIC_PATH,
        filename: path.basename(entry),
      },
      devtool: '#source-map',
      performance: {hints: false},
      cache: {},
    });
  };
  return (done) => {
    (compiler || (compiler = createCompiler())).run(function(err, stats) {
      if (err) return done(err);
      gutil.log('[webpack]', stats.toString('minimal'));
      done();
    });
  };
})());


gulp.task('javascript', gulp.parallel('javascript:main', 'javascript:polyfills'));


gulp.task('clean', function(done) {
  del(DEST).then(() => done());
});


gulp.task('default',  gulp.parallel('css', 'images', 'javascript', 'pages'));


gulp.task('serve', gulp.series('default', function() {
  let port = argv.port || argv.p || 4000;
  connect().use(serveStatic(DEST)).listen(port);

  gulp.watch('./assets/css/**/*.css', gulp.parallel('css'));
  gulp.watch('./assets/images/*', gulp.parallel('images'));
  gulp.watch('./assets/javascript/*', gulp.parallel('javascript'));
  gulp.watch(['*.html', './demos/*', './templates/*'], gulp.parallel('pages'));
}));
