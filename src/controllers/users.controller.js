/* eslint-disable no-unused-vars */
/* eslint-disable no-bitwise */
/* eslint-disable no-else-return */
import fs from 'fs';
import request from 'request';
import { resolve as resolv } from 'path';
import Responses from '../utils/response';
import hash from '../utils/hash';
import JWTHelper from '../utils/jwt';
import db from '../models';
import Mailer from '../services/Mailer.services';
import filesService from '../services/files.service';
import UserService from '../services/User.service';
import ErrorHandler from '../utils/error';
/**
 * Class for users related operations
 */
class UserController {
  /**
   * @param {object} req
   * @param {object} res
   * @returns {object} responses
   */
  async createUser(req, res) {
    const passwordHash = hash.generateSync(req.body.password);
    const host = `${req.protocol}://${req.get('host')}`;
    const userData = {
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      password: passwordHash,
    };
    const user = await db.user.create(userData);
    const token = await JWTHelper.signToken(user);
    const data = {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      token
    };
    const mail = new Mailer({
      name: userData.firstName,
      to: userData.email,
      host,
      token
    });
    await mail.sendVerificationEmail();
    return Responses.handleSuccess(201, 'created', res, data);
  }

  /**
   * Logs in a user by checking if they exist in the database
   * and if the supplied password matches the stored password
   * @param {Object} req The request object
   * @param {Object} res The response object
   * @returns {Object} A user object with selected fields
   * excluding the password
   */
  async findUser(req, res) {
    const user = await UserService.findUserByEmail(req.body.email);
    if (!user) {
      return Responses.handleError(404, 'invalid credentials', res);
    }
    if (!hash.compareSync(req.body.password, user.password)) {
      return Responses.handleError(400, 'invalid credentials', res);
    }

    const token = await JWTHelper.signToken(user);
    const data = {
      firstName: user.firstName,
      lastName: user.lastName,
      twoFASecret: user.twoFASecret,
      twoFAType: user.twoFAType,
      twoFADataURL: user.twoFADataURL,
      token,
    };
    return Responses.handleSuccess(200, 'success', res, data);
  }

  /**
   *
   * @param {object} req
   * @param {object} res
   * @returns {object} responses
   */
  async verifyAccount(req, res) {
    const { user } = res.locals;
    await db.user.update(
      {
        isVerified: true,
      },
      { where: { email: user.email } },
    );
    return res.status(200)
      .redirect(`${process.env.FRONTEND_URL}/login`);
  }

  /**
   *function resend email
   * @param {object} req
   * @param {object} res
   * @returns {object} responses
   */
  async resendEmail(req, res) {
    const { email, host } = req.query;
    const user = await db.user.findOne({
      where: { email }
    });
    if (user) {
      const token = await JWTHelper.signToken(user);
      const mail = new Mailer({
        name: user.firstName,
        to: user.email,
        token,
        host
      });
      await mail.sendVerificationEmail();
      return res.status(200)
        .redirect(`${process.env.FRONTEND_URL}/login`);
    }
    return Responses.handleError(
      404,
      'No account with such email exists, please sign up',
      res
    );
  }

  /**
   * forgot password controller
   * @param {*} req
   * @param {*} res
   * @returns {*} responses
   */
  async forgotPassword(req, res) {
    const { host } = req.query;
    const user = await UserService.findUserByEmail(req.body.email);
    if (!user) {
      return Responses.handleError(404, 'User with such email does not exist', res);
    }
    const token = await JWTHelper.signToken(user);
    const resetPasswordMail = new Mailer({
      name: user.firstName,
      to: user.email,
      host,
      token
    });
    await resetPasswordMail.sendResetPassword();
    return Responses.handleSuccess(200, 'Successful reset password please check your email', res);
  }

  /**
   * reset password controller
   * @param {*} req
   * @param {*} res
   * @returns {*} responses
   */
  async resetPassword(req, res) {
    const { user } = res.locals;
    if (!user) {
      return Responses.handleError(404, 'User does not exist, Please register', res);
    }
    const password = hash.generateSync(req.body.password);
    await db.user.update(
      {
        password
      },
      { where: { email: user.email } }
    );
    const resetPasswordMail = new Mailer({
      name: user.firstName,
      to: user.email
    });
    await resetPasswordMail.sendResetSuccess();
    return Responses.handleSuccess(
      200,
      'Updated your password successful',
      res
    );
  }

  /**
   * @name updateUserInfo
   * @description Updates user profile to complete registration
   * @param {object} req The request object
   * @param {object} res The response object
   * @returns {object} The API response
   */
  async updateUserInfo(req, res) {
    const userData = { ...req.body };
    const { user } = res.locals;

    let profilePicture = '';
    if (req.file !== undefined) {
      const {
        filename,
        path,
        mimetype,
      } = req.file;

      profilePicture = await filesService.s3Upload({ path, filename, mimetype }, 'profile_pics');
    }

    const data = await UserService.updateUserInfoByEmail({
      ...userData, profilePicture
    }, user.email);

    if (data === 'own_manage') {
      return Responses.handleError(409, 'You cannot manage your self', res);
    } else if (data === 'manager_doesnt_exist') {
      return Responses.handleError(409, 'Manager with the ID provided does not exist.', res);
    } else if (data === 'invalid_manager') {
      return Responses.handleError(409, 'Only user with role manager can be Line Managers.', res);
    }
    return Responses.handleSuccess(201, 'Updated successfully', res, data);
  }

  /**
   * @name getUserProfile
   * @description gets user profile to complete registration
   * @param {object} req The request object
   * @param {object} res The response object
   * @returns {object} The API response
   */
  async getUserProfile(req, res) {
    let { userId } = req.params;

    userId = Number(userId);

    if (typeof userId === 'number' && userId > 0 && userId >>> 0 === userId) {
      const userData = await UserService.getUserById(userId);

      if (userData) {
        const user = userData.dataValues;

        user.lineManager = user.LineManager ? {
          id: user.LineManager.id,
          firstName: user.LineManager.firstName,
          lastName: user.LineManager.lastName
        } : 'none';

        delete user.LineManager;

        const { password, lineManagerId, ...data } = user;

        return Responses.handleSuccess(200, 'Profile retrieved!', res, data);
      }
      return Responses.handleError(404, 'User not found.', res);
    }
    return Responses.handleError(422, 'User ID is not valid.', res);
  }

  /**
   *function resend email
   * @param {object} req
   * @param {object} res
   * @param {function} next
   * @returns {object} responses
   */
  async fetchAllUsers(req, res) {
    const { role } = req.query;

    const options = {
      attributes: { exclude: ['password', 'receiveNotification', 'lastLogin', 'isVerified'] },
      ...role !== undefined && { where: { role } }
    };

    const allUsers = await db.user.findAll(options);
    return Responses.handleSuccess(200, 'successfully retrieved all users', res, allUsers);
  }

  /**
   *function get users for the line manager
   * @param {object} req
   * @param {object} res
   * @param {function} next
   * @returns {object} responses
   */
  async fetchAllManagerUsers(req, res) {
    const { userId } = res.locals.user;

    const options = {
      attributes: { exclude: ['password', 'receiveNotification', 'lastLogin', 'isVerified'] },
      where: { lineManagerId: userId }
    };

    const allUsers = await db.user.findAll(options);
    return Responses.handleSuccess(200, 'successfully retrieved all users', res, allUsers);
  }

  /**
   * Upload travel documents
   * @param {object} req
   * @param {object} res
   * @returns {object} response
   */
  async uploadDocument(req, res) {
    const {
      name,
    } = req.body;

    let url = '';
    if (req.file === undefined) {
      return Responses.handleError(400, 'Document not found, upload the document', res);
    }
    const {
      filename,
      path,
      mimetype
    } = req.file;

    url = await filesService.s3Upload({ path, filename, mimetype }, 'documents');


    const { userId } = res.locals.user;

    const document = await UserService.addDocument({ name, url, userId });
    Responses.handleSuccess(201, 'Document uploaded successfully', res, { name, url, userId });
  }

  /**
   * Delete travel document
   * @param {object} req
   * @param {object} res
   * @returns {object} response
   */
  async deleteDocument(req, res) {
    const { id } = req.params;
    const { userId } = res.locals.user;

    const document = await UserService.getDocument(id);

    const isOwner = document.userId === userId;

    if (isOwner) {
      await UserService.deleteDocument(id);
      return Responses.handleSuccess(200, 'Document Deleted successfully', res);
    }
    return Responses.handleError(409, 'Document does not belong to you', res);
  }


  /**
   * Retrieve travel document
   * @param {object} req
   * @param {object} res
   * @returns {object} response
   */
  async getDocuments(req, res) {
    const { userId, role } = res.locals.user;
    let requesterId = null;
    if (role === 'requester') {
      requesterId = userId;
    }
    const documents = await UserService.retrieveDocuments({ requesterId });
    Responses.handleSuccess(200, 'Documents retrieved successfully', res, documents);
  }

  /**
   * verify a travel document
   * @param {object} req
   * @param {object} res
   * @returns {object} response
   */
  async verifyDocument(req, res) {
    const { id } = req.params;
    const { userId } = res.locals.user;
    await UserService.verifyDocument(id, userId);
    return Responses.handleSuccess(200, 'Document verified successfully', res);
  }

  /**
   * Preview document
   * @param {Object} req
   * @param {Object} res
   * @returns {File} document
   */
  async downloadDocument(req, res) {
    const { id } = req.params;
    const document = await UserService.getDocument(id);

    const dir = 'public/temp';

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
    const documentName = `${document.name}`;
    const documentOwner = `${document.documentOwner.firstName}-${document.documentOwner.lastName}`;
    const fileExtension = `${document.url.split('.').pop()}`;

    const filename = `${documentOwner}-${documentName}-${(new Date()).getTime()}.${fileExtension}`;
    const file = fs.createWriteStream(`public/temp/${filename}`);

    await new Promise((resolve, reject) => {
      const stream = request({
        uri: document.url,
        gzip: true
      })
        .pipe(file)
        .on('finish', () => {
          resolve();
        })
        .on('error', (error) => {
          reject(error);
        });
    }).catch(error => {
      throw new ErrorHandler(error);
    });

    res.download(resolv(`public/temp/${filename}`));
  }
}

export default new UserController();
